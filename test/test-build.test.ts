import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import config from '../vitest.config.js';
import setup, { buildIsStale } from './global-setup.js';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe('test build wiring', () => {
  it('uses global setup instead of an unconditional pretest build', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['pretest']).toBeUndefined();
    expect(config.test?.globalSetup).toEqual(['test/global-setup.ts']);
  });

  it('treats dist as stale when missing or older than src, fresh otherwise', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.existsSync).mockImplementation(actual.existsSync);
    const root = mkdtempSync(join(tmpdir(), 'mehmory-build-'));
    try {
      mkdirSync(join(root, 'src', 'core'), { recursive: true });
      writeFileSync(join(root, 'src', 'core', 'x.ts'), '');
      expect(buildIsStale(root)).toBe(true);

      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist', 'cli.mjs'), '');
      utimesSync(join(root, 'src', 'core', 'x.ts'), 1000, 1000);
      utimesSync(join(root, 'dist', 'cli.mjs'), 2000, 2000);
      expect(buildIsStale(root)).toBe(false);

      utimesSync(join(root, 'src', 'core', 'x.ts'), 3000, 3000);
      expect(buildIsStale(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds once when the CLI artifact is missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const build = vi.spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.alloc(0));
    setup();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('pnpm', ['build'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  });

  it('does not run the suites after a failed build', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('build failed');
    });
    expect(setup).toThrow('build failed');
  });
});
