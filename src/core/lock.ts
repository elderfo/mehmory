/**
 * Project lock (done-when 7): exclusive access via O_CREAT|O_EXCL.
 * Staleness-aware with fail-open retry bounds.
 */

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type MehmoryError, logError } from './errors.js';
import { statePath } from './home.js';
import { isContainedProjectKey } from './identity.js';
import {
  pathExists,
  readFile,
  stat,
  LOCK_RETRY_COUNT,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_STALE_MS,
  mkdir,
  remove,
  createLockExclusive,
} from './fs.js';

/** A reused PID cannot protect an abandoned lock indefinitely. */
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

/** Session state writes skip after 200 ms of contention instead of failing open. */
const SESSION_LOCK_RETRY_COUNT = 10;
const SESSION_LOCK_RETRY_INTERVAL_MS = 20;

/** Lock file path for a project key. */
function lockFilePath(key: string): string {
  const name = isContainedProjectKey(key)
    ? key.replace(/\//g, '_')
    : createHash('sha256').update(key).digest('hex');
  return join(statePath('locks'), name + '.lock');
}

/** Serialize the identity check and unlink, including recovery of abandoned guards. */
function reclaimLock(
  path: string,
  observed: NonNullable<ReturnType<typeof stat>>,
  marker: string,
  owner: string
): boolean {
  const guardPath = `${path}.reclaim`;
  if (!createLockExclusive(guardPath, owner)) {
    const guardStat = stat(guardPath);
    if (!guardStat || Date.now() - Number(guardStat.mtimeMs) <= LOCK_STALE_MS) return false;
    // A guard's reclamation needs its own guard for the same check/unlink race.
    if (!reclaimLock(guardPath, guardStat, readFile(guardPath), owner)) return false;
    if (!createLockExclusive(guardPath, owner)) return false;
  }

  try {
    const current = stat(path);
    if (
      !current ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.mtimeMs !== observed.mtimeMs ||
      readFile(path) !== marker
    ) {
      return false;
    }
    remove(path);
    return true;
  } finally {
    try {
      if (readFile(guardPath) === owner) remove(guardPath);
    } catch {
      // A failed cleanup leaves a guard recoverable after the staleness bound.
    }
  }
}

/**
 * Acquire exclusive access to a project, execute fn, then release.
 * Lock is acquired via open(..., 'wx'), which is atomic across processes.
 * Stale locks are reclaimed after their owner exits, or unconditionally after five minutes.
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
  let acquired = false;
  const owner = `${String(process.pid)}:${randomBytes(16).toString('hex')}`;

  try {
    // Try to acquire lock with retries
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      mkdir(statePath('locks'));
      // Try to create lock file exclusively
      if (createLockExclusive(lockPath, owner)) {
        acquired = true;
        break;
      }

      // Lock exists. Check if it's stale.
      if (pathExists(lockPath)) {
        try {
          const lockStat = stat(lockPath);
          const now = Date.now();
          const mtime = Number(lockStat?.mtimeMs ?? now);
          const age = now - mtime;

          if (lockStat && age > LOCK_STALE_MS) {
            const marker = readFile(lockPath);
            const ownerPid = Number(marker.split(':', 1)[0]);
            let alive = false;
            if (age <= LOCK_MAX_AGE_MS && Number.isInteger(ownerPid) && ownerPid > 0) {
              try {
                process.kill(ownerPid, 0);
                alive = true;
              } catch (error) {
                // EPERM and unknown probe failures cannot prove that the owner exited.
                alive = !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
              }
            }
            if (!alive && reclaimLock(lockPath, lockStat, marker, owner)) continue;
          }
        } catch {
          // Could not stat, retry normally
        }
      }

      // Not stale (or couldn't determine). Retry with backoff.
      if (attempt < retryCount) {
        Atomics.wait(retryWait, 0, 0, retryIntervalMs);
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
        if (readFile(lockPath) === owner) remove(lockPath);
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
  mkdir(statePath('locks'));

  const owner = `${String(process.pid)}:${randomBytes(16).toString('hex')}`;
  if (!createLockExclusive(lockPath, owner)) return undefined;

  try {
    return fn();
  } finally {
    if (pathExists(lockPath)) {
      try {
        if (readFile(lockPath) === owner) remove(lockPath);
      } catch {
        // Ignore cleanup errors; a stale lock is reclaimed by the staleness bound.
      }
    }
  }
}

/**
 * Acquire exclusive access to one session's state file, execute fn, then release.
 *
 * Session state is read-modify-write (`observeSession`), and hooks for one session
 * genuinely overlap: a Stop and a UserPromptSubmit can be in flight together, and a
 * SessionEnd can race a trailing Stop. Without this, two processes read the same state,
 * change different fields, and the later write silently discards the earlier one -- a
 * stale Stop counter can roll an advanced cursor backwards and cause a re-distill.
 *
 * Namespaced under `sessions/` so a session id can never collide with a project key in
 * the shared lock directory. Lock ordering is one-way: a session lock may be held while
 * a project lock is acquired (`finalizeSession` → `appendLogEntry` → `withProjectLock`),
 * never the reverse. Do not take a session lock inside a project lock, or the two orders
 * can deadlock until both retry budgets expire.
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
