/**
 * Cursor: track transcript read position for idempotent replay.
 *
 * The cursor persists file identity (dev:ino), file size, byte offset, and a hash
 * of the last consumed record. It advances only past complete, parsed records (never
 * mid-line). Rotation (file_id change) or truncation (size < offset) resets the offset
 * without data loss — stable entry IDs make replay a no-op.
 *
 * Cursor state machine (from plan, clause 2):
 * - fresh → advanced (entry: complete record parsed)
 * - advanced → reset (entry: file_id change or size < offset; exit: back to advanced)
 */

import { stat, pathExists, readFile, atomicWrite } from './fs.js';
import { statePath } from './home.js';

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

/**
 * Read the cursor state from disk.
 *
 * If the cursor file doesn't exist, returns an initial state with offset 0.
 * If the file is invalid JSON, returns an initial state (fail-open per A2).
 *
 * @returns Cursor state
 */
export function readCursor(): CursorState {
  const cursorPath = statePath('cursor.json');
  if (!pathExists(cursorPath)) {
    return { file_id: '', size: 0, offset: 0 };
  }

  try {
    const json = readFile(cursorPath);
    const state = JSON.parse(json) as unknown;
    if (isValidCursorState(state)) {
      return state;
    }
  } catch {
    // Invalid JSON or read error: fail open, start fresh.
  }

  return { file_id: '', size: 0, offset: 0 };
}

/**
 * Advance the cursor to track a newly parsed record.
 *
 * This is called after successfully parsing a complete record from the transcript.
 * It updates offset, file_id (if rotated), and last_hash.
 *
 * Callers are responsible for:
 * - Detecting rotation (file_id change) and calling this with the new file identity
 * - Detecting truncation (size < offset) and resetting offset to 0 before calling
 * - Passing the current file size
 *
 * @param filepath - Path to the transcript file
 * @param recordHash - Hash of the record just consumed
 * @param newOffset - New byte offset after the record
 */
export function advanceCursor(
  filepath: string,
  recordHash: string,
  newOffset: number
): void {
  const current = readCursor();
  const cursorPath = statePath('cursor.json');

  // Get current file identity.
  let fileId = current.file_id;
  let fileSize = current.size;

  try {
    const s = stat(filepath) as { dev: number | bigint; ino: number | bigint; size: number };
    // dev and ino may be BigInt on some platforms; convert to number safely.
    const devNum = Number(s.dev);
    const inoNum = Number(s.ino);
    fileId = `${devNum}:${inoNum}`;
    fileSize = s.size;
  } catch {
    // File doesn't exist or can't stat: leave fileId/size as-is.
    // This is informational; the next read will detect the rotation.
  }

  // Check for truncation or rotation.
  let offset = newOffset;
  if (current.file_id && current.file_id !== fileId) {
    // Rotation: reset offset.
    offset = 0;
  } else if (current.offset > fileSize) {
    // Truncation: reset offset.
    offset = 0;
  }

  const newState: CursorState = {
    file_id: fileId,
    size: fileSize,
    offset: offset,
    last_hash: recordHash,
  };

  atomicWrite(cursorPath, JSON.stringify(newState));
}

/**
 * Reset the cursor (e.g., on file truncation or rotation).
 *
 * Sets offset back to 0 while preserving file identity awareness.
 * Used when the transcript file is rotated or truncated externally.
 */
export function resetCursor(): void {
  const current = readCursor();
  const cursorPath = statePath('cursor.json');
  const newState: CursorState = {
    ...current,
    offset: 0,
    last_hash: undefined,
  };
  atomicWrite(cursorPath, JSON.stringify(newState));
}

/**
 * Type guard: check if an unknown value is a valid CursorState.
 */
function isValidCursorState(value: unknown): value is CursorState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.file_id === 'string' &&
    typeof v.size === 'number' &&
    typeof v.offset === 'number' &&
    (v.last_hash === undefined || typeof v.last_hash === 'string')
  );
}
