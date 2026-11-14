/**
 * Git wrapper (done-when 8): stage specific paths, retry once on index.lock, defer on second failure.
 * Accumulation is explicit: the next call commits whatever is staged, not just its own paths.
 */

import { execFileSync, type ExecFileSyncOptionsWithBufferEncoding } from 'node:child_process';
import { join } from 'node:path';
import { logError, peekWarnings, shellQuote, type MehmoryError } from './errors.js';
import {
  INDEX_LOCK_RETRY_COUNT,
  INDEX_LOCK_RETRY_INTERVAL_MS,
  LOCK_STALE_MS,
  lstat,
} from './fs.js';

export const GIT_PROBE_TIMEOUT_MS = 500;
export const GIT_OPERATION_TIMEOUT_MS = 10000;
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
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_REPLACE_REF_BASE',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
];
const GIT_PREFIX = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.useBuiltinFSMonitor=false',
];

function gitOptions(
  cwd: string | undefined,
  timeout: number
): ExecFileSyncOptionsWithBufferEncoding {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const name of GIT_LOCATION_ENV) Reflect.deleteProperty(env, name);
  return {
    stdio: 'pipe',
    timeout,
    // Git removes its own index lock on SIGTERM; SIGKILL strands it.
    killSignal: 'SIGTERM',
    env,
    ...(cwd ? { cwd } : {}),
  };
}

function isGitTimeout(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ETIMEDOUT';
}

/** Internal subprocess primitive: callers catch failures at their fail-open boundary. */
export function runStoreGit(args: string[], cwd?: string): Buffer {
  const timeout = args[0] === 'rev-parse' ? GIT_PROBE_TIMEOUT_MS : GIT_OPERATION_TIMEOUT_MS;
  try {
    const command = args[0] === 'log' ? ['log', '--no-show-signature', ...args.slice(1)] : args;
    return execFileSync('git', [...GIT_PREFIX, ...command], gitOptions(cwd, timeout));
  } catch (error) {
    if (isGitTimeout(error)) {
      const lock = join(cwd ?? process.cwd(), '.git', 'index.lock');
      logError({
        code: 'E_GIT_COMMIT',
        kind: 'informational',
        what: `git ${args[0] ?? ''} timed out after ${String(timeout)} ms; index.lock left untouched; only if no git process is running, remedy: rm ${shellQuote(lock)}`,
        consequence: 'Git operation failed; memory may be left uncommitted',
      });
    }
    throw error;
  }
}

function warnStaleIndexLock(cwd: string | undefined): void {
  const lock = join(cwd ?? process.cwd(), '.git', 'index.lock');
  try {
    const mtime = lstat(lock)?.mtime.getTime();
    if (mtime === undefined || Date.now() - mtime <= LOCK_STALE_MS) return;
    if (peekWarnings().some((warning) => warning.startsWith('E_GIT_COMMIT '))) return;
    logError({
      code: 'E_GIT_COMMIT',
      kind: 'informational',
      what: `index.lock is older than ${String(LOCK_STALE_MS)} ms; left untouched; only if no git process is running, remedy: rm ${shellQuote(lock)}`,
      consequence: 'Commit deferred; memory may be left uncommitted',
    });
  } catch {
    // The owner may have released its lock since git reported contention.
  }
}

/**
 * Stage specific paths and commit.
 * Returns { ok: true } on success.
 * On index.lock held after one retry, returns { ok: false, deferred: true }
 * with the tree left staged. Fresh lock contention is silent; an old lock queues a
 * rate-limited warning with a manual remedy.
 * Accumulation is explicit: the next call commits both this call's paths and any deferred ones.
 * @param paths - Paths to stage
 * @param message - Commit message
 * @param cwd - Optional working directory (for tests)
 */
export function ensureGitBaseline(cwd: string): { ok: true } | { ok: false } {
  try {
    runStoreGit(['rev-parse', '--git-dir'], cwd);
  } catch (error) {
    return { ok: !isGitTimeout(error) };
  }
  try {
    runStoreGit(['rev-parse', '--verify', 'HEAD'], cwd);
    return { ok: true };
  } catch (error) {
    return isGitTimeout(error) ? { ok: false } : commitPaths([], 'init: store', cwd);
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

  // Ensure we're in a git repo (will fail with clear error if not)
  try {
    runStoreGit(['rev-parse', '--git-dir'], cwd);
  } catch (caught) {
    if (isGitTimeout(caught)) return { ok: false };
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
    runStoreGit(['rev-parse', '--verify', 'HEAD'], cwd);
  } catch (error) {
    if (isGitTimeout(error)) return { ok: false };
    if (paths.length === 0) stagePaths = ['.'];
  }
  for (let attempt = 0; attempt <= INDEX_LOCK_RETRY_COUNT; attempt++) {
    try {
      // `--` keeps a filename beginning with `-` from becoming a git option.
      runStoreGit(['add', '-A', '--', ...stagePaths], cwd);
      break;
    } catch (err) {
      const what = err instanceof Error ? err.message : String(err);
      if (!isGitTimeout(err) && what.includes('index.lock')) {
        if (attempt < INDEX_LOCK_RETRY_COUNT) {
          const end = Date.now() + INDEX_LOCK_RETRY_INTERVAL_MS;
          while (Date.now() < end) {
            /* bounded contention retry */
          }
          continue;
        }
        warnStaleIndexLock(cwd);
        return { ok: false, deferred: true };
      }
      logError({
        code: 'E_GIT_COMMIT',
        kind: 'informational',
        what,
        consequence: 'Failed to stage paths; commit aborted',
      });
      return { ok: false };
    }
  }

  try {
    const staged = runStoreGit(['diff', '--cached', '--name-only'], cwd)
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
      runStoreGit(['commit', '--no-verify', '--no-gpg-sign', '-m', message], cwd);
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
        !isGitTimeout(err) &&
        (stderr.includes('index.lock') || stderr.includes('fatal: Unable to process'));

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
        warnStaleIndexLock(cwd);
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
