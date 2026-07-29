/**
 * Git wrapper (done-when 8): stage specific paths, retry once on index.lock, defer on second failure.
 * Accumulation is explicit: the next call commits whatever is staged, not just its own paths.
 */

import { execFileSync } from 'node:child_process';
import { logError, type MehmoryError } from './errors.js';
import { INDEX_LOCK_RETRY_COUNT, INDEX_LOCK_RETRY_INTERVAL_MS } from './fs.js';

/**
 * Stage specific paths and commit.
 * Returns { ok: true } on success.
 * On index.lock held after one retry, returns { ok: false, deferred: true }
 * with the tree left staged, and emits nothing (normal operation, not an error).
 * Accumulation is explicit: the next call commits both this call's paths and any deferred ones.
 * @param paths - Paths to stage
 * @param message - Commit message
 * @param cwd - Optional working directory (for tests)
 */
export function commitPaths(
  paths: string[],
  message: string,
  cwd?: string
): { ok: true } | { ok: false; deferred?: true } {
  const opts = cwd ? { cwd } : {};

  // Ensure we're in a git repo (will fail with clear error if not)
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], opts);
  } catch {
    const error: MehmoryError = {
      code: 'E_GIT_COMMIT',
      kind: 'informational',
      what: 'Not in a git repository',
      consequence: 'Commit failed; memory was not recorded',
    };
    logError(error);
    return { ok: false };
  }

  // Stage only the given paths
  try {
    // `--` terminates option parsing: without it a path beginning with `-`
    // (legal on disk, and page titles feed these paths) is read as a flag.
    execFileSync('git', ['add', '--', ...paths], opts);
  } catch (err) {
    const error: MehmoryError = {
      code: 'E_GIT_COMMIT',
      kind: 'informational',
      what: err instanceof Error ? err.message : String(err),
      consequence: 'Failed to stage paths; commit aborted',
    };
    logError(error);
    return { ok: false };
  }

  // Try to commit; retry once if index.lock is held
  for (let attempt = 0; attempt <= INDEX_LOCK_RETRY_COUNT; attempt++) {
    try {
      // --no-gpg-sign is not optional. These are machine-generated bookkeeping
      // commits in the user's memory store, and they inherit the user's global
      // `commit.gpgsign`. With signing on, git blocks on the GPG/1Password agent:
      // measured ~56s per commit before failing with "failed to write commit
      // object". Inside a hook that freezes the session on a prompt the user
      // never sees, which breaks the invariant that memory never blocks the
      // harness (A2). Signing someone's memory bookkeeping buys nothing anyway.
      execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], {
        ...opts,
        stdio: 'pipe',
      });
      // Success!
      return { ok: true };
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
        return { ok: false, deferred: true };
      }

      // Other git error
      const error: MehmoryError = {
        code: 'E_GIT_COMMIT',
        kind: 'informational',
        what: stderr,
        consequence: 'Commit failed; tree left staged for manual recovery',
      };
      logError(error);
      return { ok: false, deferred: true };
    }
  }

  // Should not reach here
  return { ok: false };
}
