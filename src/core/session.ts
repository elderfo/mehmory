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
  /** Session-level capture pause (subtractive only: never re-enables config-off hooks). */
  paused: boolean;
}

/** Path of a session's state file. Session ids are sanitized into a flat filename. */
export function sessionStatePath(sessionId: string): string {
  return statePath(`${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
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

  return {
    session_id: sessionId,
    cursor: v['cursor'],
    stop_count: v['stop_count'],
    ...(topicCache ? { topic: topicCache } : {}),
    ...(typeof v['project_key'] === 'string' ? { project_key: v['project_key'] } : {}),
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
  const next = mutate(readSessionState(sessionId));
  writeSessionState(next);
  return next;
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
      if (typeof (parsed as Record<string, unknown>)['session_id'] !== 'string') continue;
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

// ─── Project key cache / pause ───

/** Cache the resolved project key on the session (avoids re-resolving per prompt). */
export function setCachedProjectKey(sessionId: string, key: string): void {
  updateSessionState(sessionId, s => ({ ...s, project_key: key }));
}

/** Set or clear the session pause flag. */
export function setPaused(sessionId: string, paused: boolean): void {
  updateSessionState(sessionId, s => ({ ...s, paused }));
}

/** True when this session is paused. */
export function isPaused(sessionId: string): boolean {
  return readSessionState(sessionId).paused;
}
