import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { realpath } from './fs.js';

/**
 * Module-level cache for resolveProjectKey results, keyed by working directory.
 * Safe for a hook's lifetime: the resolved key is deterministic per cwd.
 */
const projectKeyCache = new Map<string, string>();

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
const SAFE_KEY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,4}$/;

function isSafeProjectKey(key: string): boolean {
  if (!SAFE_KEY.test(key)) return false;
  // Belt and braces: no segment may be a traversal token, and `.`-only segments
  // would collapse the path even though they pass the character class above.
  return key.split('/').every(seg => seg !== '.' && seg !== '..' && seg.length > 0);
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
  if (projectKeyCache.has(cwd)) {
    return projectKeyCache.get(cwd)!;
  }
  // Try to find git remote first
  const rawRemoteKey = tryGetGitRemoteKey(cwd);
  if (rawRemoteKey) {
    const remoteKey = safeRemoteKey(rawRemoteKey);
    // Alias lookup uses the sanitized key, which is what lands on disk and what a
    // user would see in `mehmory status` and copy into config.json.
    const config = loadConfig();
    if (config.identity.aliases && config.identity.aliases[remoteKey]) {
      const aliasKey = config.identity.aliases[remoteKey];
      projectKeyCache.set(cwd, aliasKey);
      return aliasKey;
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
  if (config.identity.aliases && config.identity.aliases[pathKey]) {
    const aliasKey = config.identity.aliases[pathKey];
    projectKeyCache.set(cwd, aliasKey);
    return aliasKey;
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
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // SSH protocol: ssh://git@host/owner/repo
  const sshProtoMatch = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/u);
  if (sshProtoMatch) {
    return `${sshProtoMatch[1]}/${sshProtoMatch[2]}`;
  }

  // HTTPS/HTTP: https://host/owner/repo
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+)$/u);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
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
