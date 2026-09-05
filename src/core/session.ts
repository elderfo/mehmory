/**
 * Session-scoped capture state (A13): one `.state/<session-id>.json` per session.
 *
 * Holds everything a hook needs to know about *this* session and nothing about any
 * other: the transcript cursor, the Stop counter, the topic cache, the resolved
 * project key, and the pause flag. Run 1's global `cursor.json` is gone — two sessions
 * reading different transcripts alternately would see a file_id change on every
 * invocation and reset each other into a full re-distill.
 *
 * Every read is fail-open: unreadable or corrupt state resets to fresh and logs
 * `E_SESSION_STATE`, never throws (A2, A11).
 */

import { join } from 'node:path';
import { statePath } from './home.js';
import { atomicWrite, listDir, pathExists, readFile, remove, stat } from './fs.js';
import { logError } from './errors.js';
import { advanceCursor, freshCursor, isCursorState, resetCursor, type CursorState } from './cursor.js';
import { jaccard } from './match.js';
import { loadConfig } from './config.js';
import { withSessionLock } from './lock.js';
import { isContainedProjectKey } from './identity.js';
import { INBOX_HOSTS, type InboxHost } from '../schema/format.js';

/** Cached prompt token set used to skip repeat lookups within a TTL. */
export interface TopicCache {
  /** Token set of the last prompt that triggered a lookup. */
  readonly tokens: readonly string[];
  /** Epoch ms when it was cached. */
  readonly ts: number;
}

/** Everything one session remembers between hook invocations. */
export interface SessionState {
  /** The session id this file belongs to (also the sweep marker). */
  session_id: string;
  /** Transcript read position for this session. */
  cursor: CursorState;
  /** Stop invocations since the last capture. */
  stop_count: number;
  /** Last prompt token set + timestamp, for the UserPromptSubmit topic cache. */
  topic?: TopicCache;
  /** Resolved project key, cached to keep UserPromptSubmit off the git path. */
  project_key?: string;
  /**
   * Transcript the last hook invocation reported for this session. The cursor stores
   * file identity, not a path, so without this a session that never reaches SessionEnd
   * has nothing to re-read at the next session start (issue #24).
   */
  transcript_path?: string;
  /**
   * Harness that wrote that transcript. Recorded rather than assumed: it selects the
   * reader *and* stamps the entries, so finalizing a leftover session under whichever
   * harness happens to start next would both mis-parse and mis-attribute it (issue #20).
   */
  host?: InboxHost;
  /**
   * How many times this id has been finalized already. A harness that resumes a
   * conversation reuses its session id, and each resumed run ends in a finalization of
   * its own -- so the id alone cannot identify one, and both the marker and the `log.md`
   * idempotency tag are keyed by id *and* generation. Absent means 0.
   */
  generation?: number;
  /** Session-level capture pause (subtractive only: never re-enables config-off hooks). */
  paused: boolean;
}

/** Session ids come from the harness; flattened to characters safe in a filename. */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Path of a session's state file. Session ids are sanitized into a flat filename. */
export function sessionStatePath(sessionId: string): string {
  return statePath(`${sanitizeSessionId(sessionId)}.json`);
}

/** A session that has captured nothing yet. */
export function freshSessionState(sessionId: string): SessionState {
  return { session_id: sessionId, cursor: freshCursor(), stop_count: 0, paused: false };
}

function parseSessionState(raw: string, sessionId: string): SessionState | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v['session_id'] !== 'string') return null;
  if (!isCursorState(v['cursor'])) return null;
  if (typeof v['stop_count'] !== 'number') return null;

  const topic = v['topic'];
  let topicCache: TopicCache | undefined;
  if (typeof topic === 'object' && topic !== null) {
    const t = topic as Record<string, unknown>;
    if (Array.isArray(t['tokens']) && typeof t['ts'] === 'number') {
      topicCache = { tokens: t['tokens'].filter(x => typeof x === 'string'), ts: t['ts'] };
    }
  }

  const rawHost = v['host'];
  const host =
    typeof rawHost === 'string' && (INBOX_HOSTS as readonly string[]).includes(rawHost)
      ? (rawHost as InboxHost)
      : undefined;

  return {
    session_id: sessionId,
    cursor: v['cursor'],
    stop_count: v['stop_count'],
    ...(topicCache ? { topic: topicCache } : {}),
    // `project_key` is read back from disk and handed straight to `scopePaths()`, which
    // joins it under `<home>/projects/`. The state file is a read boundary like the inbox
    // and the queue, so the key is re-validated here rather than trusted because the only
    // writer happens to sanitize. A rejected key is dropped, not repaired: the deferred
    // finalize then falls back to the sweeping session's key, which is wrong but in-store.
    ...(typeof v['generation'] === 'number' && Number.isInteger(v['generation'])
      ? { generation: v['generation'] }
      : {}),
    ...(typeof v['project_key'] === 'string' && isContainedProjectKey(v['project_key'])
      ? { project_key: v['project_key'] }
      : {}),
    ...(typeof v['transcript_path'] === 'string' ? { transcript_path: v['transcript_path'] } : {}),
    ...(host !== undefined ? { host } : {}),
    paused: v['paused'] === true,
  };
}

/**
 * Read a session's state. Missing file → fresh state. Corrupt file → fresh state plus
 * an `errors.log` entry (spec review change 3); the caller cannot tell the difference
 * and does not need to.
 */
export function readSessionState(sessionId: string): SessionState {
  const path = sessionStatePath(sessionId);
  if (!pathExists(path)) return freshSessionState(sessionId);

  try {
    const state = parseSessionState(readFile(path), sessionId);
    if (state) return state;
  } catch {
    // fall through to the reset below
  }

  logError({
    code: 'E_SESSION_STATE',
    kind: 'informational',
    what: `session state for ${sessionId} was unreadable or malformed`,
    consequence: 'Capture state reset to fresh; the transcript may be re-distilled once',
  });
  return freshSessionState(sessionId);
}

/** Persist a session's state atomically. */
export function writeSessionState(state: SessionState): void {
  atomicWrite(sessionStatePath(state.session_id), JSON.stringify(state));
}

/** Read-modify-write a session's state; returns the state that was written. */
export function updateSessionState(
  sessionId: string,
  mutate: (_state: SessionState) => SessionState
): SessionState {
  // Read and write under one lock. Hooks for a single session overlap in practice -- a
  // Stop alongside a UserPromptSubmit, a SessionEnd racing a trailing Stop -- and an
  // unserialized read-modify-write lets the later writer discard the earlier one's field,
  // which can roll an advanced cursor backwards into a re-distill.
  return (
    withSessionLock(sessionId, () => {
      const next = mutate(readSessionState(sessionId));
      writeSessionState(next);
      return next;
    }) ?? readSessionState(sessionId)
  );
}

/** Delete a session's state file (SessionEnd). No-op if it is already gone. */
export function deleteSessionState(sessionId: string): void {
  const path = sessionStatePath(sessionId);
  if (!pathExists(path)) return;
  try {
    remove(path);
  } catch {
    // Fail-open: a stale file is swept later.
  }
}

/**
 * Marker recorded once `finalizeSession` (issue #16) has completed for a session, so a
 * retried or duplicate SessionEnd invocation can tell "already finalized" apart from "a
 * session that never wrote state" — `deleteSessionState` removes the file the marker
 * would otherwise share, so the cursor's absence alone cannot mean "done".
 *
 * Deliberately a top-level `.state/*.json` with a `session_id` field, same shape
 * `sweepSessionState` already looks for: it ages out on the same schedule as ordinary
 * session state without any dedicated sweep code.
 */
function finalizedMarkerPath(sessionId: string): string {
  return statePath(`${sanitizeSessionId(sessionId)}.finalized.json`);
}

/** True once this session's `finalizeSession` call has already run to completion. */
export function isSessionFinalized(sessionId: string): boolean {
  return pathExists(finalizedMarkerPath(sessionId));
}

/**
 * Record that this session's finalization completed, so a retry becomes a no-op.
 *
 * The cursor rides along because the marker outlives the state file that held it. A
 * harness that resumes a conversation reuses its session id, and `resumeFinalizedSession`
 * hands this cursor back so the resumed run reads on from where finalization stopped
 * instead of re-distilling the whole transcript.
 */
export function markSessionFinalized(
  sessionId: string,
  cursor?: CursorState,
  generation = 0
): void {
  atomicWrite(
    finalizedMarkerPath(sessionId),
    JSON.stringify({ session_id: sessionId, generation, ...(cursor ? { cursor } : {}) })
  );
}

/** Which run of this session id we are on; 0 until the id is resumed for the first time. */
export function sessionGeneration(sessionId: string): number {
  return readSessionState(sessionId).generation ?? 0;
}

/**
 * Reopen a session id whose marker says it was already finalized.
 *
 * A marker means "the transcript up to here is captured", not "this id is done forever" —
 * but `finalizeSession` reads it as the latter, so once a resumed conversation reuses its
 * id, every later SessionEnd for it is a no-op and everything after the resume is lost.
 * Observed in the wild: a marker dated five days before the same session's live state.
 *
 * Clearing it at SessionStart is what makes the marker mean the narrower thing. Seeding
 * state with the marker's cursor keeps the resumed run from re-reading the whole
 * transcript; without it the cursor would restart at 0. That is not a correctness
 * problem — entry ids are content-stable, so the inbox dedups and `alreadyLogged` guards
 * the log line — but on a long transcript it is a great deal of wasted work.
 *
 * @returns true when a marker was cleared, i.e. this really is a resume
 */
export function resumeFinalizedSession(sessionId: string): boolean {
  return withSessionLock(sessionId, () => resumeFinalizedSessionUnlocked(sessionId)) ?? false;
}

function resumeFinalizedSessionUnlocked(sessionId: string): boolean {
  const marker = finalizedMarkerPath(sessionId);
  if (!pathExists(marker)) return false;

  let cursor: CursorState | undefined;
  let generation = 0;
  try {
    const parsed: unknown = JSON.parse(readFile(marker));
    if (typeof parsed === 'object' && parsed !== null) {
      const raw = (parsed as Record<string, unknown>)['cursor'];
      if (isCursorState(raw)) cursor = raw;
      const gen = (parsed as Record<string, unknown>)['generation'];
      if (typeof gen === 'number' && Number.isInteger(gen)) generation = gen;
    }
  } catch {
    // An unreadable marker still has to be cleared, or the session stays unfinalizable.
  }

  // The generation must advance in *both* shapes, because the `log.md` idempotency tag is
  // keyed by it and a stale tag makes the next finalize a silent no-op.
  //
  // State normally does not exist here -- `finalizeSession` deletes it before writing the
  // marker -- but state and a stale marker side by side is exactly the situation a real
  // store gets into once an id has been resumed, and skipping the bump there would leave
  // the very case this exists to fix still broken. Seed the cursor only when there is no
  // live state to take it from; never overwrite one that is already running.
  const current = readSessionState(sessionId);
  const next = Math.max(generation, current.generation ?? 0) + 1;
  const nextState = pathExists(sessionStatePath(sessionId))
    ? { ...current, generation: next }
    : { ...freshSessionState(sessionId), ...(cursor ? { cursor } : {}), generation: next };

  let markerRemoved = false;
  try {
    remove(marker);
    markerRemoved = true;
    writeSessionState(nextState);
  } catch {
    if (markerRemoved) {
      try {
        markSessionFinalized(sessionId, cursor, generation);
      } catch {
        // The next session start can recover if both writes fail transiently.
      }
    }
    return false;
  }
  return true;
}

/**
 * Record where this session's material lives, so a session that never reports an end can
 * still be finalized later (issue #24).
 *
 * Every hook payload carries `transcript_path`, and `runHook` already knows the harness
 * and the project key, so the cheapest place to learn all three is the invocation itself.
 * Written only when something actually changed — the common case is a no-op read.
 *
 * `projectKey` is the load-bearing one. A deferred finalize runs inside *another*
 * session's hook, so by then the only record of where this session ran is what was
 * persisted here; `finalizePendingSessions` falls back to the sweeping session's project
 * when it is missing, which files one project's transcript under another's scope.
 */
export function rememberSessionOrigin(
  sessionId: string,
  transcriptPath: string | undefined,
  host: InboxHost,
  projectKey: string
): void {
  if (transcriptPath === undefined || transcriptPath === '') return;
  // A hook that fires after the session was finalized (a trailing Stop, a retry, a sweep
  // that retired a session still running elsewhere) would otherwise recreate `<id>.json`
  // from `freshSessionState` -- cursor back at 0. `finalizeSession` short-circuits on the
  // marker before it ever deletes state again, so that file would sit there until
  // `sweepSessionState` removed it, and its cursor would re-distill the whole transcript
  // if the marker aged out first.
  if (isSessionFinalized(sessionId)) return;
  withSessionLock(sessionId, () => {
    const state = readSessionState(sessionId);
    if (
      state.transcript_path === transcriptPath &&
      state.host === host &&
      state.project_key === projectKey
    ) {
      return;
    }
    writeSessionState({
      ...state,
      transcript_path: transcriptPath,
      host,
      project_key: projectKey,
    });
  });
}

/**
 * How long a session's state must sit untouched before another session's start treats it
 * as abandoned and finalizes it (issue #24).
 *
 * A live session touches its state on every prompt and every Stop, so the window only has
 * to outlast a quiet stretch. Finalizing a session that is merely idle is not data loss —
 * entry ids are stable, so its next capture re-distills and dedups — but it does retire
 * that session early, which is why the window is not tighter.
 *
 * ponytail: fixed constant, not a config knob. Promote it to `session_state` if a real
 * session is ever observed idling past it.
 */
export const PENDING_FINALIZE_IDLE_MS = 30 * 60 * 1000;

/**
 * Sessions with state on disk, no finalization marker, and nothing left to lose but their
 * transcript delta: the leftovers of a session that crashed, was killed, or ran under a
 * harness with no session-end event at all (Codex).
 *
 * Only states idle for `idleMs` qualify, so a session running concurrently in another
 * terminal is not retired out from under itself. States with no recorded transcript are
 * skipped — there is nothing to distill, and finalizing them would only add a log line
 * and a commit per dead session.
 */
export function listPendingSessions(idleMs: number = PENDING_FINALIZE_IDLE_MS): SessionState[] {
  const dir = statePath();
  if (!pathExists(dir)) return [];

  const cutoff = Date.now() - idleMs;
  const pending: SessionState[] = [];

  for (const name of listDir(dir)) {
    // `<id>.finalized.json` is the marker, not state, and parses as neither.
    if (!name.endsWith('.json') || name.endsWith('.finalized.json')) continue;
    try {
      const path = join(dir, name);
      const mtime = stat(path)?.mtimeMs;

      const raw = readFile(path);
      const id: unknown = (JSON.parse(raw) as Record<string, unknown>)['session_id'];
      if (typeof id !== 'string' || id.trim() === '') continue;

      const state = parseSessionState(raw, id);
      if (!state || state.transcript_path === undefined) continue;
      if (isSessionFinalized(id)) continue;

      if (mtime === undefined || mtime > cutoff) continue;

      // State mtime moves only when a hook writes, so it says nothing about a session
      // sitting inside one long turn -- a slow build, a long tool call -- which looks
      // abandoned after the idle window and gets finalized while very much alive. Its
      // state is deleted, its id marked done, and everything it records afterwards is
      // dropped with no error anywhere.
      //
      // The transcript is the thing that actually grows while a session works: Claude Code
      // appends as it goes (`captureDelta` reads it at every Stop), and a Codex rollout is
      // written incrementally too. Requiring both to have gone quiet is what separates
      // "nobody is driving this" from "busy for a while".
      //
      // Protect-only, deliberately. A transcript that is still warm defers the finalize to
      // a later start; it never loses it. That is what keeps the ACP case correct -- a
      // rollout flushed *after* SessionEnd (#43) simply waits out the window from its own
      // mtime. A transcript that has not landed at all is left to the state mtime, because
      // that session must stay eligible rather than wait forever for a file that is
      // absent. `stat` throws on a missing path rather than returning undefined, so the
      // existence check is load-bearing, not decoration.
      if (pathExists(state.transcript_path)) {
        const transcriptMtime = stat(state.transcript_path)?.mtimeMs;
        if (transcriptMtime !== undefined && transcriptMtime > cutoff) continue;
      }

      pending.push(state);
    } catch {
      // Not a session-state file, or it vanished mid-scan: leave it to the sweep.
    }
  }

  return pending;
}

/**
 * True when `path` holds something this sweep would recognize as session state: parseable
 * JSON carrying a string `session_id`. Anything else -- truncated, hand-mangled, a
 * different file that happens to end in `.json` -- is invisible to both the sweep and
 * `listPendingSessions`, so it protects nothing and pins nothing.
 */
function isSweepableState(path: string): boolean {
  if (!pathExists(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFile(path));
    if (typeof parsed !== 'object' || parsed === null) return false;
    return typeof (parsed as Record<string, unknown>)['session_id'] === 'string';
  } catch {
    return false;
  }
}

/**
 * Delete session-state files older than `maxAgeDays` (SessionStart maintenance lane).
 * Only files that parse as session state are considered — `.state/` also holds
 * `warnings.json`, locks and logs.
 *
 * @returns number of files deleted
 */
export function sweepSessionState(maxAgeDays?: number): number {
  const days = maxAgeDays ?? loadConfig().session_state.max_age_days;
  const dir = statePath();
  if (!pathExists(dir)) return 0;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const name of listDir(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const mtime = stat(path)?.mtimeMs;
      if (mtime === undefined || mtime > cutoff) continue;
      const parsed: unknown = JSON.parse(readFile(path));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const id = (parsed as Record<string, unknown>)['session_id'];
      if (typeof id !== 'string') continue;
      // A marker matches this filter too -- it ends in `.json` and carries a `session_id`.
      // Removing one while its state file survives would un-finalize that session: the
      // state re-qualifies in `listPendingSessions` with whatever cursor it holds and the
      // transcript is distilled a second time. The marker is the younger file only when
      // state was rewritten after finalization, so outlive it rather than race it.
      //
      // Only for a state file this sweep could actually act on, though. An unparseable one
      // is skipped by its own iteration, and `listPendingSessions` skips it too, so it can
      // never un-finalize anything -- pinning the marker behind it would strand both files
      // for good instead of protecting anything.
      if (name.endsWith('.finalized.json') && isSweepableState(sessionStatePath(id))) continue;
      remove(path);
      deleted++;
    } catch {
      // Not a session-state file, or vanished mid-sweep: leave it alone.
    }
  }

  return deleted;
}

// ─── Cursor ───

/** Advance this session's cursor past a consumed record and persist it. */
export function advanceSessionCursor(
  sessionId: string,
  filepath: string,
  recordHash: string,
  newOffset: number
): CursorState {
  return updateSessionState(sessionId, s => ({
    ...s,
    cursor: advanceCursor(s.cursor, filepath, recordHash, newOffset),
  })).cursor;
}

/** Reset this session's read position to the start of the transcript. */
export function resetSessionCursor(sessionId: string): CursorState {
  return updateSessionState(sessionId, s => ({ ...s, cursor: resetCursor(s.cursor) })).cursor;
}

// ─── Stop counter ───

/** Increment and return the Stop counter for this session. */
export function incrementStopCount(sessionId: string): number {
  return updateSessionState(sessionId, s => ({ ...s, stop_count: s.stop_count + 1 })).stop_count;
}

/** Reset the Stop counter — called on every capture (Stop-threshold or PreCompact). */
export function resetStopCount(sessionId: string): void {
  updateSessionState(sessionId, s => ({ ...s, stop_count: 0 }));
}

// ─── Topic cache ───

/**
 * True when `tokens` is close enough to the cached prompt token set, recently enough,
 * that a fresh page lookup would return the same pointers.
 *
 * Thresholds come from config (`match.jaccard`, `match.cache_ttl_ms`) unless overridden.
 */
export function topicCacheHit(
  state: SessionState,
  tokens: ReadonlySet<string>,
  now: number = Date.now(),
  thresholds?: { jaccard: number; ttlMs: number }
): boolean {
  if (!state.topic) return false;
  const cfg = thresholds ?? {
    jaccard: loadConfig().match.jaccard,
    ttlMs: loadConfig().match.cache_ttl_ms,
  };
  if (now - state.topic.ts > cfg.ttlMs) return false;
  return jaccard(new Set(state.topic.tokens), tokens) >= cfg.jaccard;
}

/** Store the prompt token set that produced the current pointer set. */
export function rememberTopic(
  sessionId: string,
  tokens: ReadonlySet<string>,
  now: number = Date.now()
): void {
  updateSessionState(sessionId, s => ({ ...s, topic: { tokens: [...tokens], ts: now } }));
}

// ─── Pause ───

/** Set or clear the session pause flag. */
export function setPaused(sessionId: string, paused: boolean): void {
  updateSessionState(sessionId, s => ({ ...s, paused }));
}

/** True when this session is paused. */
export function isPaused(sessionId: string): boolean {
  return readSessionState(sessionId).paused;
}
