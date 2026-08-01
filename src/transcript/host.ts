/**
 * Reader selection by host.
 *
 * The one place a harness name is allowed to decide anything. Below this call each
 * harness's on-disk shape is a parse detail; above it there is a single record type,
 * so `src/distill/` never branches on the host and the normative distill fixtures do
 * not fork (A7).
 */

import { readTranscript, type ReadTranscriptResult } from './reader.js';
import { readCodexRollout } from './codex.js';

/** The agent harness that wrote the transcript on disk. */
export type Host = 'claude-code' | 'codex';

/**
 * Read a session transcript into normalized records, picking the reader by host.
 *
 * Both readers share the same signature and the same tolerance and cursor semantics,
 * so callers thread `startOffset` and persist `endOffset` identically either way.
 *
 * @param path - Path to the transcript or rollout .jsonl file
 * @param host - Which harness wrote it
 * @param startOffset - Byte offset to resume from (default 0 = whole file)
 */
export function readSession(path: string, host: Host, startOffset = 0): ReadTranscriptResult {
  return host === 'codex'
    ? readCodexRollout(path, startOffset)
    : readTranscript(path, startOffset);
}
