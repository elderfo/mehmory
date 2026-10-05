import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
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
      const before = treeDigest(home);
      // Avoid spending five seconds in the retry loop while exercising the real lock path.
      vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      const lock = vi.spyOn(fs, 'createLockExclusive').mockReturnValue(false);
      const result = operation === 'install' ? installCodex('codex') : uninstallCodex();
      expect(result).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
      expect(lock.mock.calls[0]?.[0]).toBe(join(home, '.mehmory-install.lock'));
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
      const result = operation === 'install' ? installCodex('codex') : uninstallCodex();
      expect(result).toMatchObject({ ok: false, error: { code: 'E_CODEX_INSTALL' } });
      expect(readFileSync(join(outside, 'mehmory-remember', 'SKILL.md'), 'utf-8')).toBe(
        'foreign bytes\n'
      );
    }
  );

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
