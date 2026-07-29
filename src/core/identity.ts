import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';

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
 */
export function resolveProjectKey(cwd: string = process.cwd()): string {
  // Try to find git remote first
  const remoteKey = tryGetGitRemoteKey(cwd);
  if (remoteKey) {
    // Check alias override
    const config = loadConfig();
    if (config.identity.aliases && config.identity.aliases[remoteKey]) {
      return config.identity.aliases[remoteKey];
    }
    return remoteKey;
  }

  // Fall back to realpath-based key (using realpath command for A3 compliance)
  let resolvedPath: string;
  try {
    resolvedPath = execFileSync('realpath', [cwd], {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    resolvedPath = cwd;
  }

  const hash = createHash('sha256').update(resolvedPath).digest('hex').slice(0, 12);
  const pathKey = `local/${hash}`;

  // Check alias override
  const config = loadConfig();
  if (config.identity.aliases && config.identity.aliases[pathKey]) {
    return config.identity.aliases[pathKey];
  }

  return pathKey;
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
