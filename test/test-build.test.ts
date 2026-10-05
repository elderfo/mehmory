import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import config from '../vitest.config.js';
import setup from './global-setup.js';

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

  it('does not build when the CLI artifact is present', () => {
    const build = vi.spyOn(childProcess, 'execFileSync');
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    setup();
    expect(exists).toHaveBeenCalledWith(join(process.cwd(), 'dist', 'cli.mjs'));
    expect(build).toHaveBeenCalledTimes(0);
  });

  it('builds once when the CLI artifact is missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const build = vi.spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.alloc(0));
    setup();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('pnpm', ['build'], {
      cwd: process.cwd(),
      stdio: 'inherit',
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
