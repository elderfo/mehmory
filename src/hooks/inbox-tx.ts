/**
 * `inbox-tx` — the transactional inbox helper skills invoke via Bash (A15).
 *
 * This file is NOT a hook. It lives beside the hook bundles because `hooks/` is where
 * the plugin's bundled `.mjs` output lands, but `hooks.json` never registers it. It is
 * CLI-shaped: a subcommand in argv[2], JSON on stdin, JSON on stdout, exit 0 on success
 * and exit 1 with a one-line stderr message on failure. The U2 no-stderr rule that binds
 * the five hook entrypoints is deliberately not applied here — a skill that silently
 * half-completed a transaction is worse than one that is told it failed.
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
import { statePath } from '../core/home.js';
import { atomicWrite, pathExists, readFile, remove } from '../core/fs.js';
import { appendInboxEntries, clearInboxEntries, readInboxEntries } from '../core/inbox.js';
import { redact } from '../core/redact.js';
import { inboxEntryId, type InboxEntry } from '../schema/format.js';

/** Thrown for any bad input or unusable state; caught at the top and reported on stderr. */
class TxError extends Error {}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => chunks.push(String(chunk)));
    process.stdin.on('end', () => {
      resolve(chunks.join(''));
    });
    process.stdin.on('error', reject);
  });
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TxError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
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

function doAppend(input: Record<string, unknown>): unknown {
  const inbox = requireString(input, 'inbox');
  const key = requireString(input, 'key');
  const raw = input['entries'];
  if (!Array.isArray(raw)) throw new TxError('"entries" must be an array');

  const ts = new Date().toISOString();
  const entries: InboxEntry[] = raw.map((item, i) => {
    const entry = asRecord(item, `entries[${String(i)}]`);
    const text = redact(requireString(entry, 'text'));
    const src = requireString(entry, 'src');
    return { id: inboxEntryId(src + text), text, src, ts };
  });

  return appendInboxEntries(inbox, entries, key);
}

function doSnapshot(input: Record<string, unknown>): unknown {
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

function doClear(input: Record<string, unknown>): unknown {
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

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const stdin = await readStdin();

  let input: Record<string, unknown>;
  try {
    input = asRecord(JSON.parse(stdin), 'stdin');
  } catch (err) {
    throw new TxError(err instanceof TxError ? err.message : 'stdin is not valid JSON');
  }

  switch (subcommand) {
    case 'append':
      return void process.stdout.write(JSON.stringify(doAppend(input)) + '\n');
    case 'snapshot':
      return void process.stdout.write(JSON.stringify(doSnapshot(input)) + '\n');
    case 'clear':
      return void process.stdout.write(JSON.stringify(doClear(input)) + '\n');
    default:
      throw new TxError(
        `unknown subcommand "${subcommand ?? ''}" (expected append|snapshot|clear)`
      );
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`inbox-tx: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
