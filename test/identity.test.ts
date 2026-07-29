import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveProjectKey } from '../src/core/identity.js';

/**
 * Test suite for resolveProjectKey.
 * Tests all five resolution cases: remote slug, no-remote path hash,
 * outside-repo path hash, worktree sharing, and alias override.
 */
describe('resolveProjectKey', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `identity-test-${randomBytes(8).toString('hex')}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
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
});
