/** Cursor, Stop counter, topic cache and pause values for one session (A13). */
import { advanceCursor, freshCursor, resetCursor, type CursorState } from './cursor.js';
import { jaccard } from './match.js';
import { loadConfig } from './config.js';
import { observeSession, inspectSession } from './session-lifecycle.js';
import type { InboxHost } from '../schema/format.js';

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
  /** Origin agent; null records an explicitly unnamed session, absent is legacy state. */
  agent?: string | null;
  /** Session-level capture pause (subtractive only: never re-enables config-off hooks). */
  paused: boolean;
}

/** A session that has captured nothing yet. */
export function freshSessionState(sessionId: string): SessionState {
  return { session_id: sessionId, cursor: freshCursor(), stop_count: 0, paused: false };
}

function mutateSession(
  sessionId: string,
  mutate: (state: SessionState) => SessionState
): SessionState | undefined {
  const result = observeSession(sessionId, (state) => Object.assign(state, mutate(state)));
  return result.status === 'observed' ? result.value : undefined;
}

function mutateOrCurrent(
  sessionId: string,
  mutate: (state: SessionState) => SessionState
): SessionState {
  return mutateSession(sessionId, mutate) ?? inspectSession(sessionId).state;
}

// ─── Cursor ───

/** Advance this session's cursor, returning undefined when lock contention skips it. */
export function advanceSessionCursor(
  sessionId: string,
  filepath: string,
  recordHash: string,
  newOffset: number
): CursorState | undefined {
  return mutateSession(sessionId, (s) => ({
    ...s,
    cursor: advanceCursor(s.cursor, filepath, recordHash, newOffset),
  }))?.cursor;
}

/** Reset this session's read position to the start of the transcript. */
export function resetSessionCursor(sessionId: string): CursorState {
  return mutateOrCurrent(sessionId, (s) => ({ ...s, cursor: resetCursor(s.cursor) })).cursor;
}

// ─── Stop counter ───

/** Increment and return the Stop counter for this session. */
export function incrementStopCount(sessionId: string): number {
  return mutateOrCurrent(sessionId, (s) => ({ ...s, stop_count: s.stop_count + 1 })).stop_count;
}

/** Reset the Stop counter — called on every capture (Stop-threshold or PreCompact). */
export function resetStopCount(sessionId: string): void {
  mutateOrCurrent(sessionId, (s) => ({ ...s, stop_count: 0 }));
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
  mutateOrCurrent(sessionId, (s) => ({ ...s, topic: { tokens: [...tokens], ts: now } }));
}

// ─── Pause ───

/** Set or clear the session pause flag. */
export function setPaused(sessionId: string, paused: boolean): boolean {
  return mutateSession(sessionId, (s) => ({ ...s, paused })) !== undefined;
}

/** True when this session is paused. */
export function isPaused(sessionId: string): boolean {
  return inspectSession(sessionId).state.paused;
}
