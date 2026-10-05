/** Shared session values; no dependency on lifecycle transitions or their callers. */
import { freshCursor, type CursorState } from './cursor.js';
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
  /** Resolved project key recorded as the session's origin. */
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
