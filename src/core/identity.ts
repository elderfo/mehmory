import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfig, type MehmoryConfig } from './config.js';
import { realpath } from './fs.js';

/**
 * Module-level cache for resolveProjectKey results, keyed by working directory.
 * Safe for a hook's lifetime: the resolved key is deterministic per cwd.
 */
const projectKeyCache = new Map<string, string>();

function configuredAlias(config: MehmoryConfig, key: string): string | undefined {
  const identity: unknown = config.identity;
  if (typeof identity !== 'object' || identity === null) return undefined;
  const aliases = (identity as Record<string, unknown>)['aliases'];
  if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) return undefined;
  const alias = (aliases as Record<string, unknown>)[key];
  return typeof alias === 'string' ? alias : undefined;
}

/**
 * A project key becomes a directory name under <home>/projects/, so it must not be
 * able to escape that root. A crafted remote such as
 * `https://github.com/owner/../../../../tmp/pwned.git` otherwise yields the key
 * `github.com/owner/../../../../tmp/pwned`, which path.join() normalizes to a
 * location outside the store — an arbitrary write triggered by cloning a hostile repo.
 *
 * Accepts only host/owner/repo shapes built from safe characters. Anything else is
 * rejected so the caller can fall back to the hash-based key.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * True when `key` can only ever name a location *inside* `<home>/projects/`.
 *
 * This is the containment question on its own, deliberately separate from the
 * remote-slug shape check below. A one-segment key is perfectly contained -- an
 * `identity.aliases` entry of `my-custom-key` is a documented, supported shape -- it
 * simply is not a `host/owner/repo` slug. Conflating the two rejects valid aliases.
 *
 * Use this at every boundary where a key arrives from outside the process and is about
 * to become a path: the session state file, the queue payload, config aliases.
 */
export function isContainedProjectKey(key: string): boolean {
  const segments = key.split('/');
  if (segments.length === 0 || segments.length > 5) return false;
  // No segment may be empty or a traversal token, and `.`-only segments would collapse
  // the path even though they pass the character class.
  return segments.every(seg => seg !== '.' && seg !== '..' && SAFE_SEGMENT.test(seg));
}

function isSafeProjectKey(key: string): boolean {
  // A remote-derived key is `host/owner/repo`-ish, so it must have at least two segments
  // on top of being contained; a bare one-segment result means normalization went wrong
  // and hashing it is better than trusting it.
  return key.includes('/') && isContainedProjectKey(key);
}

/**
 * Make a remote-derived key safe to use as a directory name WITHOUT discarding the
 * identity it carries.
 *
 * Rejecting an unsafe key and falling back to a path hash would be a silent
 * regression of A5: `file://` remotes and deep group paths are perfectly
 * legitimate, and path-hashing them gives every worktree of one repo a different
 * key — the exact fragmentation the remote-slug scheme exists to prevent.
 *
 * So: readable shapes pass through unchanged, and anything else collapses to a
 * hash of the normalized remote. Same remote still means same key, so worktrees
 * and clones continue to share one memory, and the result cannot escape the store.
 */
function safeRemoteKey(normalizedRemote: string): string {
  if (isSafeProjectKey(normalizedRemote)) return normalizedRemote;
  const hash = createHash('sha256').update(normalizedRemote).digest('hex').slice(0, 12);
  return `remote/${hash}`;
}

/**
 * Resolve a stable, deterministic project key for a given working directory.
 *
 * Resolution order:
 * 1. If config.json has an alias entry matching the computed key, return the alias
 * 2. If in a git repository with a remote: normalized git remote slug (github.com/owner/repo)
 * 3. If in a git repository with no remote: local/<sha256-hash>[0..12]
 * 4. Outside a git repository: local/<sha256-hash>[0..12]
 *
 * The key is based on git remote if available (making worktrees/clones share memory)
 * or filesystem identity (realpath) if not.
 *
 * Results are cached at module level to avoid repeated git subprocess calls.
 * The cache is keyed by cwd and is safe for a hook's lifetime.
 */
export function resolveProjectKey(cwd: string = process.cwd()): string {
  // Check cache first to avoid repeated git subprocess calls
  const cached = projectKeyCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  // Try to find git remote first
  const rawRemoteKey = tryGetGitRemoteKey(cwd);
  if (rawRemoteKey) {
    const remoteKey = safeRemoteKey(rawRemoteKey);
    // Alias lookup uses the sanitized key, which is what lands on disk and what a
    // user would see in `mehmory status` and copy into config.json.
    const config = loadConfig();
    const aliasKey = configuredAlias(config, remoteKey);
    if (aliasKey !== undefined) {
      // An alias is hand-written config, so unlike the computed key above it never passed
      // through `safeRemoteKey`. It becomes a directory name all the same, so an alias of
      // `../../../tmp/x` would escape the store exactly like a hostile remote would.
      // Reject rather than sanitize: silently rewriting someone's alias to a hash would be
      // more confusing than ignoring it and using the real key.
      // `aliases` is typed `Record<string, string>`, but config.json is user JSON and
      // `deepMerge` enforces no value types -- a number reaches `key.split` and throws out
      // of `resolveProjectKey`, which `runHook` catches fail-open, so every hook for that
      // project silently does nothing.
      if (typeof aliasKey === 'string' && isContainedProjectKey(aliasKey)) {
        projectKeyCache.set(cwd, aliasKey);
        return aliasKey;
      }
    }
    projectKeyCache.set(cwd, remoteKey);
    return remoteKey;
  }

  // No remote at all. Hash filesystem identity.
  //
  // Inside a repo this MUST be the toplevel, not the cwd: hashing the cwd gives a
  // different key for every subdirectory a session happens to start in, silently
  // splitting one project's memory across many stores. Criterion 3 specifies the
  // toplevel for exactly this reason.
  const base = tryGetGitToplevel(cwd) ?? cwd;
  const resolvedPath = realpath(base);

  const hash = createHash('sha256').update(resolvedPath).digest('hex').slice(0, 12);
  const pathKey = `local/${hash}`;

  // Check alias override
  const config = loadConfig();
  const aliasKey = configuredAlias(config, pathKey);
  if (aliasKey !== undefined) {
    // Same reason as the remote-derived branch: an alias is unvalidated user config.
    // Same reason as the remote-derived branch: the value is unenforced user JSON.
    if (typeof aliasKey === 'string' && isContainedProjectKey(aliasKey)) {
      projectKeyCache.set(cwd, aliasKey);
      return aliasKey;
    }
  }

  projectKeyCache.set(cwd, pathKey);
  return pathKey;
}

/**
 * Absolute path of the repository root, or undefined outside a repo.
 * Used so every directory inside one repo resolves to a single project key.
 */
function tryGetGitToplevel(cwd: string): string | undefined {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return top || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Try to extract and normalize the git remote slug.
 * Returns undefined if not in a repo or if the repo has no origin remote.
 */
function tryGetGitRemoteKey(cwd: string): string | undefined {
  try {
    // Check if we're in a git repository
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' });

    // Get the origin remote URL
    const remoteUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (!remoteUrl) {
      return undefined;
    }

    return normalizeRemoteUrl(remoteUrl);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a git remote URL to a canonical slug.
 *
 * Handles multiple forms:
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - ssh://git@github.com/owner/repo
 * - https://github.com/owner/repo (with or without trailing slash)
 * - Other hosts work too (gitlab.com, bitbucket.org, etc.)
 *
 * Returns: host/owner/repo (e.g., github.com/owner/repo)
 */
function normalizeRemoteUrl(url: string): string {
  url = url.trim();

  // Remove trailing .git and slashes
  if (url.endsWith('.git')) {
    url = url.slice(0, -4);
  }
  url = url.replace(/\/+$/, '');

  // SSH format: git@host:owner/repo
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    // Capture groups are always present when the match succeeds; the `?? ''`
    // fallback only exists to satisfy noUncheckedIndexedAccess and is never hit.
    const [, host, path] = sshMatch;
    return `${host ?? ''}/${path ?? ''}`;
  }

  // SSH protocol: ssh://git@host/owner/repo
  const sshProtoMatch = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/u);
  if (sshProtoMatch) {
    const [, host, path] = sshProtoMatch;
    return `${host ?? ''}/${path ?? ''}`;
  }

  // HTTPS/HTTP: https://host/owner/repo
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+)$/u);
  if (httpsMatch) {
    const [, host, path] = httpsMatch;
    return `${host ?? ''}/${path ?? ''}`;
  }

  // Fallback: assume it's already in host/owner/repo format
  return url;
}

/**
 * Clear the project key cache. Used for testing to prevent cache poisoning
 * when tests create temporary repositories.
 */
export function clearProjectKeyCache(): void {
  projectKeyCache.clear();
}
