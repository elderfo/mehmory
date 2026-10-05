import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCodex, uninstallCodex } from '../src/core/codex-install.js';
import * as fs from '../src/core/fs.js';
import { CLI, treeDigest } from './cli-fixture.js';
import { createTempDir, hermeticEnv } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('Codex install safety', () => {
  it('refuses an incomplete installed package through the built CLI', () => {
    const packageDir = createTempDir('mehmory-incomplete-package');
    mkdirSync(join(packageDir, 'dist'));
    const cli = join(packageDir, 'dist', 'cli.mjs');
    writeFileSync(cli, readFileSync(CLI));
    const home = process.env.CODEX_HOME ?? '';
    const store = join(createTempDir('mehmory-store-parent'), 'store');
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n');
    const before = treeDigest(home);
    const result = spawnSync(process.execPath, [cli, 'init', '--host', 'codex', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: hermeticEnv({ MEHMORY_HOME: store }),
    });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      errors: [{ code: 'E_CODEX_INSTALL' }],
    });
    expect(treeDigest(home)).toBe(before);
    expect(existsSync(store)).toBe(false);
  });

  it('restores all staged skills if the hook edit is refused', () => {
    const home = process.env.CODEX_HOME ?? '';
    expect(installCodex('codex').ok).toBe(true);
    writeFileSync(join(home, 'hooks.json'), '{ invalid JSON');
    const before = treeDigest(home);
    expect(uninstallCodex()).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
    expect(treeDigest(home)).toBe(before);
  });

  it('refuses missing hook bundles before writing configuration or skills', () => {
    const home = process.env.CODEX_HOME ?? '';
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n');
    const before = treeDigest(home);
    const pathExists = fs.pathExists;
    vi.spyOn(fs, 'pathExists').mockImplementation(path =>
      path.endsWith('.mjs') ? false : pathExists(path)
    );
    expect(installCodex('codex')).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
    expect(treeDigest(home)).toBe(before);
  });

  it.each(['install', 'uninstall'] as const)(
    'refuses %s while the shared Codex-home lock is held',
    operation => {
      const home = process.env.CODEX_HOME ?? '';
      const lockPath = join(home, '.mehmory-install.lock');
      writeFileSync(lockPath, `${String(process.pid)}:held`);
      writeFileSync(join(home, 'hooks.json'), '{}\n');
      const before = treeDigest(home);
      // Avoid spending five seconds in the retry loop while exercising the real lock path.
      vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      const lock = vi.spyOn(fs, 'createLockExclusive').mockReturnValue(false);
      const result = operation === 'install' ? installCodex('codex') : uninstallCodex();
      expect(result).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
      expect(lock.mock.calls[0]?.[0]).toBe(lockPath);
      expect(result).toMatchObject({
        error: { fix: `retry after the other process finishes; if stale, remove ${lockPath}` },
      });
      expect(treeDigest(home)).toBe(before);
      expect(readdirSync(process.env.MEHMORY_HOME ?? '')).toEqual([]);
    }
  );

  it.each(['install', 'uninstall'] as const)(
    'refuses %s through a symlinked skills root',
    operation => {
      const home = process.env.CODEX_HOME ?? '';
      const outside = createTempDir('mehmory-foreign-skills');
      mkdirSync(join(outside, 'mehmory-remember'));
      writeFileSync(join(outside, 'mehmory-remember', 'SKILL.md'), 'foreign bytes\n');
      symlinkSync(outside, join(home, 'skills'));
      writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n');
      writeFileSync(join(home, 'hooks.json'), '{}\n');
      const before = treeDigest(home);
      const result = operation === 'install' ? installCodex('codex') : uninstallCodex();
      expect(result).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
      expect(readFileSync(join(outside, 'mehmory-remember', 'SKILL.md'), 'utf-8')).toBe(
        'foreign bytes\n'
      );
      expect(treeDigest(home)).toBe(before);
    }
  );

  it.each(['config.toml', 'hooks.json'])(
    'writes and backs up the real target of symlinked %s',
    name => {
      const home = process.env.CODEX_HOME ?? '';
      const outside = createTempDir('mehmory-dotfiles');
      const target = join(outside, name);
      const link = join(home, name);
      const original = name === 'config.toml' ? '[features]\nhooks = false\n' : '{}\n';
      writeFileSync(target, original);
      symlinkSync(target, link);
      expect(installCodex('codex').ok).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf-8')).not.toBe(original);
      expect(readFileSync(`${target}.mehmory.bak`, 'utf-8')).toBe(original);
      expect(existsSync(`${link}.mehmory.bak`)).toBe(false);
      expect(uninstallCodex().ok).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      if (name === 'hooks.json')
        expect(readFileSync(target, 'utf-8')).toBe('{\n  "hooks": {}\n}\n');
    }
  );

  it('refuses dangling configuration symlinks without severing them', () => {
    const home = process.env.CODEX_HOME ?? '';
    symlinkSync(join(home, 'missing'), join(home, 'config.toml'));
    expect(installCodex('codex').ok).toBe(false);
    expect(lstatSync(join(home, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(readdirSync(home)).toEqual(['config.toml']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports the real permission failure on a read-only Codex home',
    () => {
      const home = process.env.CODEX_HOME ?? '';
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      chmodSync(home, 0o500);
      try {
        const result = installCodex('codex');
        expect(result).toMatchObject({
          ok: false,
          error: {
            consequence: `${join(home, '.mehmory-install.lock')} was not modified, so the Codex integration is not in place`,
          },
        });
        if (result.ok) throw new Error('expected installation to fail');
        expect(result.error.what).toContain('EACCES');
        expect(wait).not.toHaveBeenCalled();
      } finally {
        chmodSync(home, 0o700);
      }
    }
  );

  it.each(['install', 'uninstall'] as const)(
    'reports %s lock write failures immediately',
    operation => {
      const home = process.env.CODEX_HOME ?? '';
      writeFileSync(join(home, 'hooks.json'), '{}\n');
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      vi.spyOn(fs, 'createLockExclusive').mockReturnValue(false);
      const result = operation === 'install' ? installCodex('codex') : uninstallCodex();
      expect(result).toMatchObject({
        ok: false,
        error: {
          consequence: `${join(home, '.mehmory-install.lock')} was not modified, so the Codex integration ${operation === 'install' ? 'is not in place' : 'was not removed'}`,
        },
      });
      expect(wait).not.toHaveBeenCalled();
    }
  );

  it('preflights every skill target before writing configuration or earlier skills', () => {
    const home = process.env.CODEX_HOME ?? '';
    mkdirSync(join(home, 'skills', 'mehmory-resume'), { recursive: true });
    const outside = createTempDir('mehmory-skill-target');
    writeFileSync(join(outside, 'SKILL.md'), 'foreign bytes\n');
    symlinkSync(join(outside, 'SKILL.md'), join(home, 'skills', 'mehmory-resume', 'SKILL.md'));
    const before = treeDigest(home);
    expect(installCodex('codex').ok).toBe(false);
    expect(treeDigest(home)).toBe(before);
  });

  it('preflights missing skill sources before writing configuration', () => {
    const home = process.env.CODEX_HOME ?? '';
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(join(home, 'hooks.json'), '{}\n');
    const before = treeDigest(home);
    const pathExists = fs.pathExists;
    vi.spyOn(fs, 'pathExists').mockImplementation(path =>
      path.endsWith('/skills') && path !== join(home, 'skills') ? false : pathExists(path)
    );
    expect(installCodex('codex').ok).toBe(false);
    expect(treeDigest(home)).toBe(before);
  });

  it('stops a skill-component walk at the filesystem root if its boundary moves', () => {
    const home = process.env.CODEX_HOME ?? '';
    const originalHome = process.env.CODEX_HOME;
    const lstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation(path => {
      if (path === join(home, 'skills')) process.env.CODEX_HOME = join(home, 'moved');
      if (path === '/') throw new Error('walk escaped its boundary');
      return lstat(path);
    });
    try {
      expect(installCodex('codex')).toMatchObject({
        ok: false,
        error: { what: 'skill path is outside the Codex skills directory' },
      });
    } finally {
      process.env.CODEX_HOME = originalHome;
    }
  });

  it('documents every Codex installation refusal and cleanup consequence', () => {
    const docs = readFileSync('docs/TROUBLESHOOTING.md', 'utf-8');
    for (const reason of [
      'Unsupported features shape or unsafe TOML',
      'could not be determined',
      'dotfiles repository',
      'Missing hook bundles',
      'Lock contention',
      'Staged-skill cleanup incomplete',
      'Symlinked configuration targets',
      'Codex integration was removed, but staged skill cleanup is incomplete',
      'was not modified, so the Codex integration was not removed',
    ])
      expect(docs).toContain(reason);
    expect(readFileSync('docs/CLI.md', 'utf-8')).toContain('could not be determined');
    expect(readFileSync('docs/CLI.md', 'utf-8')).toContain('dotfiles repository');
    expect(readFileSync('README.md', 'utf-8')).toContain(
      'syntax or missing hook bundles are refused'
    );
    expect(readFileSync('CHANGELOG.md', 'utf-8')).toContain(
      'deliberately replacing the pristine pre-mehmory backup'
    );
  });

  it('uninstall write failures describe removal rather than installation', () => {
    expect(installCodex('codex').ok).toBe(true);
    const home = process.env.CODEX_HOME ?? '';
    const atomicWrite = fs.atomicWrite;
    vi.spyOn(fs, 'atomicWrite').mockImplementation((path, body, mode) => {
      if (path === join(home, 'hooks.json')) throw new Error('write refused');
      atomicWrite(path, body, mode);
    });
    expect(uninstallCodex()).toMatchObject({
      ok: false,
      error: {
        consequence: `${join(home, 'hooks.json')} was not modified, so the Codex integration was not removed`,
      },
    });
  });

  it('restores staged skill directories and hooks if staging removal fails midway', () => {
    const home = process.env.CODEX_HOME ?? '';
    expect(installCodex('codex').ok).toBe(true);
    const extra = join(home, 'skills', 'mehmory-integrate', 'nested');
    mkdirSync(extra);
    writeFileSync(join(extra, 'asset.bin'), Buffer.from([0, 255, 254, 1]));
    const before = treeDigest(home);
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (from === join(home, 'skills', 'mehmory-lint')) throw new Error('staging refused');
      rename(from, to);
    });
    expect(uninstallCodex()).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
    expect(treeDigest(home)).toBe(before);
  });

  it('keeps uninstall consistent if deleting staged skills fails midway', () => {
    const home = process.env.CODEX_HOME ?? '';
    expect(installCodex('codex').ok).toBe(true);
    const config = readFileSync(join(home, 'config.toml'), 'utf-8');
    const removeDir = fs.removeDir;
    let removed = 0;
    vi.spyOn(fs, 'removeDir').mockImplementation(path => {
      if (path.includes('mehmory-') && ++removed === 2) throw new Error('removal refused');
      removeDir(path);
    });
    expect(uninstallCodex()).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
    expect(readFileSync(join(home, 'hooks.json'), 'utf-8')).toBe('{\n  "hooks": {}\n}\n');
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toBe(config);
    expect(readdirSync(join(home, 'skills'))).toEqual([]);
    expect(existsSync(join(home, 'skills', 'mehmory-integrate'))).toBe(false);
  });
});
