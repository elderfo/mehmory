/**
 * Project lock (done-when 7): exclusive access via O_CREAT|O_EXCL.
 * Staleness-aware with fail-open retry bounds.
 */

import { join } from 'node:path';
import { type MehmoryError, logError } from './errors.js';
import { statePath, mehmoryHome } from './home.js';
import {
  pathExists,
  stat,
  LOCK_RETRY_COUNT,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_STALE_MS,
  mkdir,
  remove,
  createLockExclusive,
} from './fs.js';

/**
 * Session locks get far tighter retry bounds than project locks.
 *
 * This one is taken on every prompt and every Stop, and `withProjectLock` retries by
 * *busy-waiting* -- the project default of 50 x 100ms would burn five seconds of CPU
 * inside a hook. The critical section here is one small read plus one atomic write, so
 * contention resolves in microseconds or not at all; on timeout the lock fails open the
 * same way, which is no worse than the unserialized write this replaces.
 */
const SESSION_LOCK_RETRY_COUNT = 10;
const SESSION_LOCK_RETRY_INTERVAL_MS = 20;

/** Lock file path for a project key. */
function lockFilePath(key: string): string {
  return join(statePath('locks'), key.replace(/\//g, '_') + '.lock');
}

/**
 * Acquire exclusive access to a project, execute fn, then release.
 * Lock is acquired via open(..., 'wx'), which is atomic across processes.
 * Stale locks (mtime > lock.stale_ms) are reclaimed.
 * Retries at most retryCount × retryIntervalMs, then proceeds without lock and logs E_LOCK_TIMEOUT.
 * Release on both success and throw.
 * @param key - Project key
 * @param fn - Function to execute with lock
 * @param retryCount - Max retry attempts (default: 50)
 * @param retryIntervalMs - Interval between retries in ms (default: 100)
 * @param failOpen - Run without the lock after retries when true (default: true)
 */
export function withProjectLock<T>(
  key: string,
  fn: () => T,
  retryCount?: number,
  retryIntervalMs?: number,
  failOpen?: true
): T;
export function withProjectLock<T>(
  key: string,
  fn: () => T,
  retryCount: number,
  retryIntervalMs: number,
  failOpen: false
): T | undefined;
export function withProjectLock<T>(
  key: string,
  fn: () => T,
  retryCount: number = LOCK_RETRY_COUNT,
  retryIntervalMs: number = LOCK_RETRY_INTERVAL_MS,
  failOpen = true
): T | undefined {
  const lockPath = lockFilePath(key);
  mkdir(join(mehmoryHome(), '.state', 'locks'));

  let acquired = false;

  try {
    // Try to acquire lock with retries
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      // Try to create lock file exclusively
      if (createLockExclusive(lockPath)) {
        acquired = true;
        break;
      }

      // Lock exists. Check if it's stale.
      if (pathExists(lockPath)) {
        try {
          const lockStat = stat(lockPath);
          if (!lockStat) {
            // Retry after backoff
            if (attempt < retryCount) {
              const end = Date.now() + retryIntervalMs;
              while (Date.now() < end) {
                // Busy-wait
              }
            }
            continue;
          }

          const now = Date.now();
          const mtime = typeof lockStat.mtimeMs === 'number' ? lockStat.mtimeMs : 0;
          const age = now - mtime;

          if (age > LOCK_STALE_MS) {
            // Stale lock; try to reclaim it
            try {
              remove(lockPath);
              // Retry immediately
              continue;
            } catch {
              // Race: someone else deleted it or acquired it, retry normally
            }
          }
        } catch {
          // Could not stat, retry normally
        }
      }

      // Not stale (or couldn't determine). Retry with backoff.
      if (attempt < retryCount) {
        // Sleep before retry
        const end = Date.now() + retryIntervalMs;
        while (Date.now() < end) {
          // Busy-wait (sync, no setImmediate available)
        }
      }
    }

    if (!acquired) {
      const error: MehmoryError = {
        code: 'E_LOCK_TIMEOUT',
        kind: 'informational',
        what: `project lock held for over ${String((retryCount * retryIntervalMs) / 1000)}s; ${failOpen ? 'proceeded without it' : 'skipped the operation'}`,
        consequence: failOpen
          ? 'A concurrent session may have overwritten an index rewrite'
          : 'The operation will be retried by a later hook',
      };
      logError(error);
      if (!failOpen) return undefined;
    }

    return fn();
  } finally {
    // Release lock on both success and throw
    if (acquired && pathExists(lockPath)) {
      try {
        remove(lockPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Maintenance-lane lock (A16): acquire on the first attempt or give up.
 *
 * `withProjectLock` fails open — after its retry bound it runs `fn` *without* the lock.
 * That is right on the capture path and wrong on the maintenance path, where the
 * contract is "skip and let the next session retry" rather than "run unprotected". This
 * is the A8 bound family's hook-maintenance mode: 1 attempt, no retry, no timeout log.
 *
 * @returns the result of `fn`, or `undefined` when the lock was not free
 */
export function tryProjectLock<T>(key: string, fn: () => T): T | undefined {
  const lockPath = lockFilePath(key);
  mkdir(join(mehmoryHome(), '.state', 'locks'));

  if (!createLockExclusive(lockPath)) return undefined;

  try {
    return fn();
  } finally {
    if (pathExists(lockPath)) {
      try {
        remove(lockPath);
      } catch {
        // Ignore cleanup errors; a stale lock is reclaimed by the staleness bound.
      }
    }
  }
}

/**
 * Acquire exclusive access to one session's state file, execute fn, then release.
 *
 * Session state is read-modify-write (`updateSessionState`), and hooks for one session
 * genuinely overlap: a Stop and a UserPromptSubmit can be in flight together, and a
 * SessionEnd can race a trailing Stop. Without this, two processes read the same state,
 * change different fields, and the later write silently discards the earlier one -- a
 * stale Stop counter can roll an advanced cursor backwards and cause a re-distill.
 *
 * Namespaced under `sessions/` so a session id can never collide with a project key in
 * the shared lock directory. Session locks are leaves: nothing taken inside one acquires
 * a project lock, so the two can never deadlock against each other.
 */
export function withSessionLock<T>(sessionId: string, fn: () => T): T | undefined {
  return withProjectLock(
    `sessions/${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}`,
    fn,
    SESSION_LOCK_RETRY_COUNT,
    SESSION_LOCK_RETRY_INTERVAL_MS,
    false
  );
}
