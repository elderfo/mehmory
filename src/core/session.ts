/** Cursor, Stop counter, topic cache and pause values for one session (A13). */
import { advanceCursor, resetCursor, type CursorState } from './cursor.js';
import { jaccard } from './match.js';
import { loadConfig } from './config.js';
import { observeSession, inspectSession } from './session-lifecycle.js';
import type { SessionState } from './session-state.js';

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
