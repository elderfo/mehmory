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
 */
export function withProjectLock<T>(
  key: string,
  fn: () => T,
  retryCount: number = LOCK_RETRY_COUNT,
  retryIntervalMs: number = LOCK_RETRY_INTERVAL_MS
): T {
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

    // If we couldn't acquire lock after all retries, proceed without lock (fail-open)
    if (!acquired) {
      const error: MehmoryError = {
        code: 'E_LOCK_TIMEOUT',
        kind: 'informational',
        what: `project lock held for over ${(retryCount * retryIntervalMs) / 1000}s; proceeded without it`,
        consequence: 'A concurrent session may have overwritten an index rewrite',
      };
      logError(error);
    }

    // Execute function (with or without lock)
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
