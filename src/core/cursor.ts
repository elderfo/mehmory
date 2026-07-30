/**
 * Cursor: transcript read position, as pure functions over a state value (A13).
 *
 * The cursor persists file identity (dev:ino), file size, byte offset, and a hash
 * of the last consumed record. It advances only past complete, parsed records (never
 * mid-line). Rotation (file_id change) or truncation (size < offset) resets the offset
 * without data loss — stable entry IDs make replay a no-op.
 *
 * There is no global cursor file: run 2 scopes the cursor to a session
 * (`.state/<session-id>.json`, see `session.ts`), because interleaved sessions reading
 * different transcripts otherwise reset each other's offset on every alternation. This
 * module owns the state transitions; `session.ts` owns persistence.
 *
 * Cursor state machine:
 * - fresh → advanced (entry: complete record parsed)
 * - advanced → reset (entry: file_id change or size < offset; exit: back to advanced)
 */

import { stat } from './fs.js';

/**
 * Cursor state: file identity, size, byte offset, and hash of last record.
 *
 * file_id = "<dev>:<ino>" (stable across rotations/renames within the same filesystem).
 */
export interface CursorState {
  /** File identity: "<dev>:<ino>". */
  file_id: string;
  /** File size at last successful read. */
  size: number;
  /** Byte offset: position of next record to read. */
  offset: number;
  /** Hash of the last successfully consumed record (for deduplication). */
  last_hash?: string;
}

/** A cursor that has read nothing. */
export function freshCursor(): CursorState {
  return { file_id: '', size: 0, offset: 0 };
}

/** Type guard for a cursor value read back off disk. */
export function isCursorState(value: unknown): value is CursorState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['file_id'] === 'string' &&
    typeof v['size'] === 'number' &&
    typeof v['offset'] === 'number' &&
    (v['last_hash'] === undefined || typeof v['last_hash'] === 'string')
  );
}

/** Current file identity ("<dev>:<ino>") and size, or null if the file is unreadable. */
export function fileIdentity(filepath: string): { file_id: string; size: number } | null {
  try {
    const s = stat(filepath) as { dev: number | bigint; ino: number | bigint; size: number };
    return { file_id: `${String(Number(s.dev))}:${String(Number(s.ino))}`, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Advance a cursor past a newly parsed record, detecting rotation and truncation.
 *
 * Pure: returns the next state, writes nothing. Rotation (file identity changed) or
 * truncation (stored offset past current EOF) resets the offset to 0; replay from 0 is
 * safe because entry ids are stable.
 *
 * @param current - Cursor state before this record
 * @param filepath - Path to the transcript file
 * @param recordHash - Hash of the record just consumed
 * @param newOffset - Byte offset just past that record
 */
export function advanceCursor(
  current: CursorState,
  filepath: string,
  recordHash: string,
  newOffset: number
): CursorState {
  const identity = fileIdentity(filepath);
  const fileId = identity ? identity.file_id : current.file_id;
  const fileSize = identity ? identity.size : current.size;

  let offset = newOffset;
  if (current.file_id && current.file_id !== fileId) {
    offset = 0; // rotation
  } else if (current.offset > fileSize) {
    offset = 0; // truncation
  }

  return { file_id: fileId, size: fileSize, offset, last_hash: recordHash };
}

/** Reset the read position while keeping file identity awareness. */
export function resetCursor(current: CursorState): CursorState {
  return { ...current, offset: 0, last_hash: undefined };
}
