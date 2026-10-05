/**
 * Git wrapper (done-when 8): stage specific paths, retry once on index.lock, defer on second failure.
 * Accumulation is explicit: the next call commits whatever is staged, not just its own paths.
 */

import { execFileSync, type ExecFileSyncOptionsWithBufferEncoding } from 'node:child_process';
import { logError, type MehmoryError } from './errors.js';
import { INDEX_LOCK_RETRY_COUNT, INDEX_LOCK_RETRY_INTERVAL_MS } from './fs.js';

const GIT_TIMEOUT_MS = 500;
const GIT_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_CONFIG',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_REPLACE_REF_BASE',
];
const GIT_PREFIX = ['-c', 'core.hooksPath=/dev/null'];

function gitOptions(cwd?: string): ExecFileSyncOptionsWithBufferEncoding {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_ENV) Reflect.deleteProperty(env, name);
  return {
    stdio: 'pipe',
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env,
    ...(cwd ? { cwd } : {}),
  };
}

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
export function ensureGitBaseline(cwd: string): { ok: true } | { ok: false } {
  try {
    execFileSync('git', [...GIT_PREFIX, 'rev-parse', '--git-dir'], gitOptions(cwd));
  } catch {
    return { ok: true };
  }
  try {
    execFileSync('git', [...GIT_PREFIX, 'rev-parse', '--verify', 'HEAD'], gitOptions(cwd));
    return { ok: true };
  } catch {
    return commitPaths([], 'init: store', cwd);
  }
}

export function commitPaths(
  paths: string[],
  message: string,
  cwd?: string,
  strictPaths = false
): { ok: true } | { ok: false; deferred?: true } {
  // `stdio: 'pipe'` is part of the U2 contract, not a tidiness choice: without it the
  // child git inherits the caller's stderr, and a hook running inside Claude Code
  // leaks `fatal: …` straight past the fail-open boundary.
  const opts = gitOptions(cwd);

  // Ensure we're in a git repo (will fail with clear error if not)
  try {
    execFileSync('git', [...GIT_PREFIX, 'rev-parse', '--git-dir'], opts);
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

  // Stage only the given paths once the store has a baseline. A fresh store has no
  // HEAD yet, so its initial files are all part of the first commit.
  let stagePaths = paths;
  try {
    execFileSync('git', [...GIT_PREFIX, 'rev-parse', '--verify', 'HEAD'], opts);
  } catch {
    if (paths.length === 0) stagePaths = ['.'];
  }
  try {
    // `--` terminates option parsing: without it a path beginning with `-`
    // (legal on disk, and page titles feed these paths) is read as a flag.
    execFileSync('git', [...GIT_PREFIX, 'add', '-A', '--', ...stagePaths], opts);
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

  try {
    const staged = execFileSync('git', [...GIT_PREFIX, 'diff', '--cached', '--name-only'], opts)
      .toString()
      .split('\n')
      .filter(Boolean);
    if (staged.length === 0) return { ok: true };
    if (strictPaths) {
      const allowed = paths.map((path) =>
        path.replace(/^:\(top,literal\)/, '').replace(/\\/g, '/')
      );
      const unrelated = staged.some(
        (file) => !allowed.some((path) => file === path || file.startsWith(path + '/'))
      );
      if (unrelated) {
        logError({
          code: 'E_GIT_COMMIT',
          kind: 'informational',
          what: 'unrelated changes are already staged in the memory store',
          consequence: 'Purge left the store dirty rather than committing user changes',
        });
        return { ok: false };
      }
    }
  } catch {
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
      execFileSync(
        'git',
        [...GIT_PREFIX, 'commit', '--no-verify', '--no-gpg-sign', '-m', message],
        {
          ...opts,
          stdio: 'pipe',
        }
      );
      // Success!
      return { ok: true };
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      // Another process may have committed the same staged tree after our diff.
      const failure = err as { status?: number; stdout?: Buffer };
      if (
        failure.status === 1 &&
        /nothing to commit|nothing added to commit/.test(failure.stdout?.toString() ?? '')
      ) {
        return { ok: true };
      }

      // Check if it's index.lock contention
      const isIndexLock =
        stderr.includes('index.lock') || stderr.includes('fatal: Unable to process');

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
