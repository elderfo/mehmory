/**
 * File system primitives (A3: the only module importing node:fs).
 * Provides atomic writes, append-safe records, and support for lock.ts, git.ts, queue.ts.
 */

import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fstatSync,
  existsSync,
  statSync,
  renameSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { logError, type MehmoryError } from './errors.js';

// ─── Bounds (A8) ───

/** Lock retry: 50 attempts × 100ms = 5 seconds max. */
export const LOCK_RETRY_COUNT = 50;
/** Lock retry interval (ms). */
export const LOCK_RETRY_INTERVAL_MS = 100;
/** Lock staleness threshold (ms). */
export const LOCK_STALE_MS = 30000;

/** Index.lock retry: 1 × 100 ms before deferring. */
export const INDEX_LOCK_RETRY_COUNT = 1;
/** Index.lock retry interval (ms). */
export const INDEX_LOCK_RETRY_INTERVAL_MS = 100;

/** Queue claim attempts: 3 before moving to failed. */
export const QUEUE_CLAIM_ATTEMPTS = 3;
/** Queue claim staleness threshold (ms). */
export const QUEUE_STALE_MS = 30000;

/** Atomicity ceiling for appends (4 KiB). Above this, use lock path. */
export const APPEND_ATOMIC_CEILING_BYTES = 4 * 1024;

// ─── Helper functions for lock.ts, git.ts, queue.ts ───

/**
 * Read all of stdin synchronously (A9), as UTF-8.
 *
 * Hook entrypoints and the inbox-tx helper receive their whole input as one JSON
 * document on stdin. This lives here because A3 makes fs.ts the only module allowed
 * to touch node:fs, and fd 0 is the portable synchronous stdin handle.
 *
 * Returns '' when stdin is closed or unreadable — the caller treats that as an empty
 * payload and fails open rather than throwing on a hook the harness invoked oddly.
 */
export function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

/** Check if a path exists. */
export function pathExists(path: string): boolean {
  return existsSync(path);
}

/** Get file stat. */
export function stat(path: string): ReturnType<typeof statSync> {
  return statSync(path);
}

/** Read file as UTF-8 string. */
export function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * Read a file from a byte offset to EOF, without materializing the bytes before it.
 *
 * Transcripts reach tens of MB and the capture cursor exists precisely so each pass
 * only reads what was appended since the last one. Reading the whole file and then
 * slicing would defeat that — it costs the full file every pass no matter how small
 * the tail is. Lives here because A3 confines node:fs to this module.
 *
 * Returns '' if the offset is at or past EOF. An offset past EOF is treated as EOF
 * rather than an error: a truncated file is a normal condition the cursor recovers
 * from, not a failure.
 */
export function readFileFrom(path: string, offset: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = offset > 0 ? Math.min(offset, size) : 0;
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Create directory recursively. */
export function mkdir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Rename/move a file (atomic on POSIX). */
export function rename(from: string, to: string): void {
  renameSync(from, to);
}

/** Remove a file. */
export function remove(path: string): void {
  unlinkSync(path);
}

/** Remove a directory recursively. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Resolve a path to its canonical form, following symlinks.
 *
 * Exists here because A3 confines node:fs to this module. identity.ts previously
 * shelled out to the `realpath(1)` binary to stay inside that rule, which is not
 * present on every macOS install and silently fell back to the unresolved path —
 * producing a different project key for a symlinked checkout.
 *
 * Returns the input unchanged if the path cannot be resolved (e.g. does not exist).
 */
export function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** List files in a directory. */
export function listDir(path: string): string[] {
  return readdirSync(path);
}

/** Create a lock file exclusively (fails if it already exists). Returns true on success. */
export function createLockExclusive(path: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// ─── Atomic write ───

/**
 * Write contents atomically: write to a temp file in the same directory,
 * then rename into place. Creates parent directories.
 */
export function atomicWrite(path: string, contents: string): void {
  const dir = dirname(path);
  mkdir(dir);

  // Write to temp file with random suffix
  const tempPath = path + '.tmp-' + Math.random().toString(36).slice(2, 8);
  writeFileSync(tempPath, contents, 'utf-8');

  // Atomic rename on POSIX
  rename(tempPath, path);
}

// ─── Append-safe record ───

/**
 * Append exactly one JSON-escaped line to a file via a single O_APPEND write.
 *
 * Records smaller than APPEND_ATOMIC_CEILING_BYTES use direct append (atomic on POSIX).
 * Records at or above the ceiling use the lock path for atomicity.
 *
 * Embedded newlines are JSON-escaped to preserve the one-line invariant.
 *
 * @param path - File to append to
 * @param record - String to append (one logical unit)
 * @param key - Project key for lock path (required for ceiling protection)
 * @param lockPath - Lock function for large records (obtain via `withProjectLock` from `src/core/lock.ts`).
 *                   This parameter exists to break the fs.ts ↔ lock.ts circular import: lock.ts imports fs.ts,
 *                   so fs.ts cannot import lock.ts directly.
 * @returns { ok: true } | { ok: false; error: string }
 */
export function appendRecord(
  path: string,
  record: string,
  key: string,
  lockPath: (_key: string, _fn: () => void) => void
): { ok: true } | { ok: false; error: string } {
  // JSON-escape any embedded newlines to preserve one-line invariant
  const escaped = record.replace(/\n/g, '\\n');

  const createErrorResult = (caught: unknown): MehmoryError => ({
    code: 'E_APPEND_FAILED',
    // Informational: "check file permissions and disk space" is prose, not a runnable
    // command, and U10 admits only the latter under `Fix:`.
    kind: 'informational',
    what: caught instanceof Error ? caught.message : String(caught),
    consequence: 'Record was not appended',
  });

  // Determine if we need the lock path
  if (escaped.length >= APPEND_ATOMIC_CEILING_BYTES) {
    // Use lock path for atomicity on large records
    try {
      lockPath(key, () => {
        mkdir(dirname(path));
        appendFileSync(path, escaped + '\n', 'utf-8');
      });
      return { ok: true };
    } catch (err) {
      const error = createErrorResult(err);
      logError(error);
      return { ok: false, error: 'append_failed_with_lock' };
    }
  } else {
    // Direct O_APPEND write for atomicity (POSIX guarantee)
    mkdir(dirname(path));

    try {
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, escaped + '\n', null, 'utf-8');
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (err) {
      const error = createErrorResult(err);
      logError(error);
      return { ok: false, error: 'append_failed' };
    }
  }
}
