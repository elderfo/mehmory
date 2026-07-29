/**
 * Git wrapper (done-when 8): stage specific paths, retry once on index.lock, defer on second failure.
 * Accumulation is explicit: the next call commits whatever is staged, not just its own paths.
 */

import { execFileSync } from 'node:child_process';
import { logError, type MehmoryError } from './errors.js';
import { INDEX_LOCK_RETRY_COUNT, INDEX_LOCK_RETRY_INTERVAL_MS } from './fs.js';

/**
 * Stage specific paths and commit.
 * Returns { committed: true } on success.
 * On index.lock held after one retry, returns { committed: false, deferred: true }
 * with the tree left staged, and emits nothing (normal operation, not an error).
 * Accumulation is explicit: the next call commits both this call's paths and any deferred ones.
 */
export function commitPaths(
  paths: string[],
  message: string
): { readonly committed: boolean; readonly deferred?: boolean } {
  // Ensure we're in a git repo (will fail with clear error if not)
  try {
    execFileSync('git', ['rev-parse', '--git-dir']);
  } catch {
    const error: MehmoryError = {
      code: 'E_GIT_COMMIT',
      kind: 'informational',
      what: 'Not in a git repository',
      consequence: 'Commit failed; memory was not recorded',
    };
    logError(error);
    return { committed: false };
  }

  // Stage only the given paths
  try {
    execFileSync('git', ['add', ...paths]);
  } catch (err) {
    const error: MehmoryError = {
      code: 'E_GIT_COMMIT',
      kind: 'informational',
      what: err instanceof Error ? err.message : String(err),
      consequence: 'Failed to stage paths; commit aborted',
    };
    logError(error);
    return { committed: false };
  }

  // Try to commit; retry once if index.lock is held
  for (let attempt = 0; attempt <= INDEX_LOCK_RETRY_COUNT; attempt++) {
    try {
      execFileSync('git', ['commit', '-m', message], { stdio: 'pipe' });
      // Success!
      return { committed: true };
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);

      // Check if it's index.lock contention
      const isIndexLock = stderr.includes('index.lock') || stderr.includes('fatal: Unable to process');

      if (isIndexLock && attempt < INDEX_LOCK_RETRY_COUNT) {
        // Retry after delay
        const end = Date.now() + INDEX_LOCK_RETRY_INTERVAL_MS;
        while (Date.now() < end) {
          // Busy-wait
        }
        continue;
      }

      // Second failure or not index.lock: leave staged and return deferred
      if (isIndexLock) {
        // Normal deferral, no error logged
        return { committed: false, deferred: true };
      }

      // Other git error
      const error: MehmoryError = {
        code: 'E_GIT_COMMIT',
        kind: 'informational',
        what: stderr,
        consequence: 'Commit failed; tree left staged for manual recovery',
      };
      logError(error);
      return { committed: false, deferred: true };
    }
  }

  // Should not reach here
  return { committed: false };
}
