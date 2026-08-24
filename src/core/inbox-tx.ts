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
 *   append   {inbox, key, host?, entries:[{text, src}]}  -> {appended, skipped}
 *   snapshot {inbox, key}                                -> {snapshotId, entries}
 *   clear    {inbox, key, snapshotId}                    -> {removed}
 *
 * `snapshot` persists the snapshotted id list under `<MEHMORY_HOME>/.state/`; `clear`
 * removes exactly those ids and deletes the snapshot file. Entries appended between the
 * two calls survive — that is the whole reason the model must not clear the inbox with
 * a raw Edit (the spec's "inbox is never lost" contract).
 */

import { randomBytes } from 'node:crypto';
import { currentAgentName } from './agent.js';
import { type MehmoryConfig } from './config.js';
import { statePath } from './home.js';
import { atomicWrite, pathExists, readFile, remove } from './fs.js';
import { appendInboxEntries, clearInboxEntries, readInboxEntries } from './inbox.js';
import { redact } from './redact.js';
import { readSessionState } from './session.js';
import { INBOX_HOSTS, inboxEntryId, type InboxEntry, type InboxHost } from '../schema/format.js';

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

/**
 * The harness to attribute an appended entry to.
 *
 * Declared beats inferred (A23): the caller passes a top-level `host` and it wins. An
 * unrecognized value is a hard error rather than a silent fall-through to the
 * serializer's `claude-code` default — a well-formed line with the wrong attribution is
 * exactly the failure issue #20 exists to prevent, and it is invisible once written.
 *
 * With no `host` declared, the entry's `src` — a session id — is resolved against that
 * session's recorded state, which is the authoritative record of which harness wrote it
 * (`finalizePendingSessions` prefers it over the running host for the same reason). That
 * keeps a re-appended older entry attributed to the session that produced it rather than
 * to whatever harness is running now. Only when neither is available does the entry go
 * out without a host and pick up the serializer's default.
 */
function declaredHost(input: Record<string, unknown>): InboxHost | undefined {
  const value = input['host'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(INBOX_HOSTS as readonly string[]).includes(value)) {
    throw new TxError(`unknown "host" (expected ${INBOX_HOSTS.join('|')})`);
  }
  return value as InboxHost;
}

/**
 * Why `agent` has no declared counterpart to `host`.
 *
 * `host` accepts a top-level override because a *better* source than the running
 * process exists: the session that produced the entry recorded its own harness, so a
 * re-appended entry stays attributed to it. There is no such source for the agent —
 * session state records none — so a declared `agent` could only ever be a guess, and
 * this helper runs inside the agent's own process, where `MEHMORY_AGENT` is the
 * authoritative answer.
 *
 * A declared value is refused rather than ignored, for the same reason an unknown
 * `host` is refused: `agent=` is the routing decision integrate reads, so a wrong or
 * silently-dropped one files the memory into the wrong scope permanently, and that is
 * invisible once written.
 *
 * Checked on the payload *and* on every entry: refusing only the top level would leave an
 * `entries[i].agent` silently dropped and the running agent stamped in its place — the
 * exact ignored-not-refused outcome this exists to prevent. (`host` differs: it takes a
 * top-level override because session state is a better source than the running process,
 * so the two are not one rule.)
 */
function rejectDeclaredAgent(input: Record<string, unknown>, where: string): void {
  if (input['agent'] !== undefined) {
    throw new TxError(`"agent" cannot be declared${where}; it comes from MEHMORY_AGENT`);
  }
}

function doAppend(
  input: Record<string, unknown>,
  config: MehmoryConfig
): Record<string, unknown> {
  const inbox = requireString(input, 'inbox');
  const key = requireString(input, 'key');
  const raw = input['entries'];
  if (!Array.isArray(raw)) throw new TxError('"entries" must be an array');

  const host = declaredHost(input);
  rejectDeclaredAgent(input, '');
  // The running agent, resolved once for the whole append the way `secrets` is: the CLI
  // and the bundled helper both run in the agent's own process (R1). Without this the
  // remember path drops the stamp that `distillDelta`/`rememberEntry` set, and integrate
  // reads a missing `agent=` as "project fact", never as "stamp lost".
  const agent = currentAgentName(config);
  // Config is threaded from the adapter (A21); `redact` never reads it itself, and one
  // read serves the whole append rather than one per entry (criterion 13).
  const secrets = config.secrets;
  const ts = new Date().toISOString();
  const entries: InboxEntry[] = raw.map((item, i) => {
    const entry = asRecord(item, `entries[${String(i)}]`);
    rejectDeclaredAgent(entry, ` on entries[${String(i)}]`);
    const text = redact(requireString(entry, 'text'), secrets);
    const src = requireString(entry, 'src');
    const entryHost = host ?? readSessionState(src).host;
    return {
      id: inboxEntryId(src + text),
      text,
      src,
      ...(entryHost !== undefined ? { host: entryHost } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ts,
    };
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

  // Parsed through `parseJsonRecord` so a truncated snapshot reports the same actionable
  // TxError as a mis-shaped one, instead of leaking a raw JSON SyntaxError to the skill.
  const stored = parseJsonRecord(readFile(path), 'snapshot file');
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
 *
 * `config` is threaded by the adapter rather than read here (A21).
 */
export function runInboxTx(
  subcommand: string,
  input: Record<string, unknown>,
  config: MehmoryConfig
): Record<string, unknown> {
  switch (subcommand) {
    case 'append':
      return doAppend(input, config);
    case 'snapshot':
      return doSnapshot(input);
    case 'clear':
      return doClear(input);
    default:
      throw new TxError(`unknown subcommand "${subcommand}" (expected append|snapshot|clear)`);
  }
}
