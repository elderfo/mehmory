/**
 * Transactional inbox helper logic (A15, A17).
 *
 * Two entry points reach the inbox transactionally: the bundled `hooks/inbox-tx.mjs`
 * script skills shell out to (`src/hooks/inbox-tx.ts`), and `mehmory inbox-tx` on the
 * CLI (`src/cli/commands/inbox-tx.ts`). Neither re-implements the validation or the
 * append/snapshot/clear logic — this module is the one place it lives, so the CLI stays
 * a thin consumer of the same behavior rather than a second implementation (A17).
 *
 * Subcommands:
 *   append   {inbox, key, entries:[{text, src}]}  -> {appended, skipped}
 *   snapshot {inbox, key}                         -> {snapshotId, entries}
 *   clear    {inbox, key, snapshotId}             -> {removed}
 *
 * `snapshot` persists the snapshotted id list under `<MEHMORY_HOME>/.state/`; `clear`
 * removes exactly those ids and deletes the snapshot file. Entries appended between the
 * two calls survive — that is the whole reason the model must not clear the inbox with
 * a raw Edit (the spec's "inbox is never lost" contract).
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { statePath } from './home.js';
import { atomicWrite, pathExists, readFile, remove } from './fs.js';
import { appendInboxEntries, clearInboxEntries, readInboxEntries } from './inbox.js';
import { redact } from './redact.js';
import { inboxEntryId, type InboxEntry } from '../schema/format.js';

/** Thrown for any bad input or unusable state; callers report it and exit non-zero. */
export class TxError extends Error {}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TxError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Parse `raw` as a JSON object, wrapping both parse and shape failures as `TxError`. */
export function parseJsonRecord(raw: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TxError(`${what} is not valid JSON`);
  }
  return asRecord(parsed, what);
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value === '') {
    throw new TxError(`missing or empty "${field}"`);
  }
  return value;
}

function snapshotFile(snapshotId: string): string {
  if (!/^[0-9a-f]{16}$/.test(snapshotId)) {
    throw new TxError(`malformed snapshotId "${snapshotId}"`);
  }
  return statePath(`inbox-snapshot.${snapshotId}.json`);
}

function doAppend(input: Record<string, unknown>): Record<string, unknown> {
  const inbox = requireString(input, 'inbox');
  const key = requireString(input, 'key');
  const raw = input['entries'];
  if (!Array.isArray(raw)) throw new TxError('"entries" must be an array');

  // Loaded once for the whole append, not per entry: `redact` never reads config
  // itself (criterion 13).
  const secrets = loadConfig().secrets;
  const ts = new Date().toISOString();
  const entries: InboxEntry[] = raw.map((item, i) => {
    const entry = asRecord(item, `entries[${String(i)}]`);
    const text = redact(requireString(entry, 'text'), secrets);
    const src = requireString(entry, 'src');
    return { id: inboxEntryId(src + text), text, src, ts };
  });

  return appendInboxEntries(inbox, entries, key);
}

function doSnapshot(input: Record<string, unknown>): Record<string, unknown> {
  const inbox = requireString(input, 'inbox');
  requireString(input, 'key');
  const entries = readInboxEntries(inbox);
  const snapshotId = randomBytes(8).toString('hex');
  atomicWrite(
    snapshotFile(snapshotId),
    JSON.stringify({ inbox, ids: entries.map(e => e.id) })
  );
  return { snapshotId, entries };
}

function doClear(input: Record<string, unknown>): Record<string, unknown> {
  const inbox = requireString(input, 'inbox');
  const key = requireString(input, 'key');
  const path = snapshotFile(requireString(input, 'snapshotId'));
  if (!pathExists(path)) throw new TxError('unknown snapshotId (already cleared?)');

  const stored = asRecord(JSON.parse(readFile(path)), 'snapshot file');
  const ids = stored['ids'];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
    throw new TxError('corrupt snapshot file');
  }

  const result = clearInboxEntries(inbox, key, ids as string[]);
  remove(path);
  return result;
}

/**
 * Run one inbox-tx subcommand against an already-parsed JSON input object.
 *
 * Both `hooks/inbox-tx.ts` and `src/cli/commands/inbox-tx.ts` call this directly — it is
 * the whole implementation; they differ only in how they get `input` from the outside
 * world and how they report the result.
 */
export function runInboxTx(subcommand: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (subcommand) {
    case 'append':
      return doAppend(input);
    case 'snapshot':
      return doSnapshot(input);
    case 'clear':
      return doClear(input);
    default:
      throw new TxError(`unknown subcommand "${subcommand}" (expected append|snapshot|clear)`);
  }
}
