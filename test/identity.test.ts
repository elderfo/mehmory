import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveProjectKey, clearProjectKeyCache } from '../src/core/identity.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

/**
 * Test suite for resolveProjectKey.
 * Tests all five resolution cases: remote slug, no-remote path hash,
 * outside-repo path hash, worktree sharing, and alias override.
 */
describe('resolveProjectKey', () => {
  let tempDir: string;

  beforeEach(() => {
    clearProjectKeyCache();
    tempDir = createTempDir('identity-test');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('resolves git remote slug for a repo with origin', () => {
    // Create a temp git repo with an origin remote
    const repoDir = join(tempDir, 'repo-with-remote');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/owner/repo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const key = resolveProjectKey(repoDir);
    expect(key).toBe('github.com/owner/repo');
  });

  it('normalizes SSH remote format (git@host:owner/repo.git)', () => {
    const repoDir = join(tempDir, 'repo-ssh');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin git@github.com:owner/repo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const key = resolveProjectKey(repoDir);
    expect(key).toBe('github.com/owner/repo');
  });

  it('normalizes SSH protocol format (ssh://git@host/owner/repo)', () => {
    const repoDir = join(tempDir, 'repo-ssh-protocol');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin ssh://git@github.com/owner/repo', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const key = resolveProjectKey(repoDir);
    expect(key).toBe('github.com/owner/repo');
  });

  it('handles non-GitHub hosts (e.g., gitlab.com)', () => {
    const repoDir = join(tempDir, 'repo-gitlab');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://gitlab.com/mygroup/myrepo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const key = resolveProjectKey(repoDir);
    expect(key).toBe('gitlab.com/mygroup/myrepo');
  });

  it('falls back to path hash when repo has no origin remote', () => {
    const repoDir = join(tempDir, 'repo-no-remote');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    // Note: no git remote add

    const key = resolveProjectKey(repoDir);
    expect(key).toMatch(/^local\/[a-f0-9]{12}$/);
  });

  it('falls back to cwd path hash when outside any git repo', () => {
    const nonRepoDir = join(tempDir, 'not-a-repo');
    mkdirSync(nonRepoDir, { recursive: true });

    const key = resolveProjectKey(nonRepoDir);
    expect(key).toMatch(/^local\/[a-f0-9]{12}$/);
  });

  it('uses realpath for path hash to handle symlinks consistently', () => {
    const realDir = join(tempDir, 'real-dir');
    const linkDir = join(tempDir, 'link-dir');
    mkdirSync(realDir, { recursive: true });

    // Create a symlink
    execSync(`ln -s "${realDir}" "${linkDir}"`);

    const keyFromReal = resolveProjectKey(realDir);
    const keyFromLink = resolveProjectKey(linkDir);

    // Both should resolve to the same key
    expect(keyFromReal).toBe(keyFromLink);
    // And both should be path-hashes (not remote-based)
    expect(keyFromReal).toMatch(/^local\/[a-f0-9]{12}$/);
  });

  it('two worktrees of one remote resolve to the same key', () => {
    // Create a bare repo
    const bareRepo = join(tempDir, 'bare.git');
    mkdirSync(bareRepo, { recursive: true });
    execSync('git init --bare', { cwd: bareRepo, stdio: 'pipe' });

    // Create first checkout
    const checkout1 = join(tempDir, 'checkout1');
    mkdirSync(checkout1, { recursive: true });
    execSync(`git clone file://${bareRepo} .`, { cwd: checkout1, stdio: 'pipe' });

    // Create first worktree
    const worktree1 = join(tempDir, 'worktree1');
    execSync(`git worktree add ${worktree1}`, { cwd: checkout1, stdio: 'pipe' });

    // Create second worktree
    const worktree2 = join(tempDir, 'worktree2');
    execSync(`git worktree add ${worktree2}`, { cwd: checkout1, stdio: 'pipe' });

    const key1 = resolveProjectKey(checkout1);
    const key2 = resolveProjectKey(worktree1);
    const key3 = resolveProjectKey(worktree2);

    // All three should resolve to the same key (they share the same .git/config)
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });

  it('ignores a config alias that would escape the store', () => {
    // An alias is hand-written config and never passes through `safeRemoteKey`, but it
    // becomes a directory name all the same. Fall back to the real computed key rather
    // than silently rewriting someone's alias into a hash.
    const repoDir = join(tempDir, 'repo-with-escaping-alias');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/owner/repo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const home = join(tempDir, '.mehmory-escape');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        identity: { aliases: { 'github.com/owner/repo': '../../../../tmp/pwned' } },
      }),
      'utf-8'
    );

    const originalHome = process.env.MEHMORY_HOME;
    process.env.MEHMORY_HOME = home;

    try {
      expect(resolveProjectKey(repoDir)).toBe('github.com/owner/repo');
    } finally {
      if (originalHome) {
        process.env.MEHMORY_HOME = originalHome;
      } else {
        delete process.env.MEHMORY_HOME;
      }
    }
  });

  it('ignores a non-string alias instead of throwing out of resolveProjectKey', () => {
    // `aliases` is typed Record<string, string>, but config.json is user JSON and no
    // runtime check enforces the value type. A number would reach `key.split` and throw;
    // `runHook` catches fail-open, so every hook for that project would silently no-op.
    const repoDir = join(tempDir, 'repo-with-numeric-alias');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/owner/repo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const home = join(tempDir, '.mehmory-numeric');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ identity: { aliases: { 'github.com/owner/repo': 42 } } }),
      'utf-8'
    );

    const originalHome = process.env.MEHMORY_HOME;
    process.env.MEHMORY_HOME = home;

    try {
      expect(() => resolveProjectKey(repoDir)).not.toThrow();
      expect(resolveProjectKey(repoDir)).toBe('github.com/owner/repo');
    } finally {
      if (originalHome) {
        process.env.MEHMORY_HOME = originalHome;
      } else {
        delete process.env.MEHMORY_HOME;
      }
    }
  });

  it('ignores a null aliases container instead of throwing', () => {
    const repoDir = join(tempDir, 'repo-with-null-aliases');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/owner/repo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const home = join(tempDir, '.mehmory-null-aliases');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ identity: { aliases: null } }), 'utf-8');

    const originalHome = process.env.MEHMORY_HOME;
    process.env.MEHMORY_HOME = home;

    try {
      expect(() => resolveProjectKey(repoDir)).not.toThrow();
      expect(resolveProjectKey(repoDir)).toBe('github.com/owner/repo');
    } finally {
      if (originalHome) {
        process.env.MEHMORY_HOME = originalHome;
      } else {
        delete process.env.MEHMORY_HOME;
      }
    }
  });

  it('allows config.json alias to override computed key', () => {
    // This test verifies that if config.json has an alias entry,
    // resolveProjectKey will return the alias instead of the computed key.
    // We'll create a repo with a remote and then mock the config to have an alias.

    const repoDir = join(tempDir, 'repo-with-alias');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/owner/repo.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    // Create a config.json with an alias
    const mehmoryHome = join(tempDir, '.mehmory');
    mkdirSync(mehmoryHome, { recursive: true });
    const configPath = join(mehmoryHome, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        identity: {
          aliases: {
            'github.com/owner/repo': 'my-custom-key',
          },
        },
      }),
      'utf-8'
    );

    // Temporarily set MEHMORY_HOME to our test directory
    const originalHome = process.env.MEHMORY_HOME;
    process.env.MEHMORY_HOME = mehmoryHome;

    try {
      const key = resolveProjectKey(repoDir);
      expect(key).toBe('my-custom-key');
    } finally {
      if (originalHome) {
        process.env.MEHMORY_HOME = originalHome;
      } else {
        delete process.env.MEHMORY_HOME;
      }
    }
  });

  it('resolves the same key from a subdirectory of a repo with no remote', () => {
    // Regression: the fallback hashed cwd rather than the git toplevel, so every
    // subdirectory a session started in produced a different key and silently
    // split one project's memory across separate stores.
    const repoDir = join(tmpdir(), `identity-sub-${randomBytes(8).toString('hex')}`);
    const deep = join(repoDir, 'src', 'nested');
    mkdirSync(deep, { recursive: true });
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });

    try {
      const atRoot = resolveProjectKey(repoDir);
      const atDepth = resolveProjectKey(deep);

      expect(atRoot).toMatch(/^local\/[0-9a-f]{12}$/);
      expect(atDepth).toBe(atRoot);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses a traversal-carrying remote instead of using it as a directory name', () => {
    // Regression: the key is joined into <home>/projects/<key>, so a remote
    // containing ../ escaped the store root and gave an attacker who could get a
    // repo cloned an arbitrary write. Falls back to the safe hash key.
    const repoDir = join(tmpdir(), `identity-trav-${randomBytes(8).toString('hex')}`);
    mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/owner/../../../../tmp/pwned.git', {
      cwd: repoDir,
      stdio: 'pipe',
    });

    try {
      const key = resolveProjectKey(repoDir);

      expect(key).not.toContain('..');
      // The load-bearing assertion: whatever the key is, joining it under the
      // store root must stay under the store root.
      expect(join('/store/projects', key).startsWith('/store/projects/')).toBe(true);
      // Sanitized to a hash of the remote rather than rejected, so two worktrees
      // of even a hostile-looking remote still share one memory.
      expect(key).toMatch(/^remote\/[0-9a-f]{12}$/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('gives the same sanitized key to two clones of one unsafe-shaped remote', () => {
    // Sanitizing must preserve identity, not just safety: same remote, same key.
    const mk = (): string => {
      const d = join(tmpdir(), `identity-san-${randomBytes(8).toString('hex')}`);
      mkdirSync(d, { recursive: true });
      execSync('git init', { cwd: d, stdio: 'pipe' });
      execSync('git remote add origin file:///srv/git/shared/deep/path/repo.git', {
        cwd: d,
        stdio: 'pipe',
      });
      return d;
    };
    const a = mk();
    const b = mk();
    try {
      expect(resolveProjectKey(a)).toBe(resolveProjectKey(b));
      expect(resolveProjectKey(a)).toMatch(/^remote\/[0-9a-f]{12}$/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
