import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite, appendRecord } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

afterEach(() => vi.restoreAllMocks());

describe('atomicWrite durability', () => {
  it('preserves a chained relative symlink and updates its final target', () => {
    const dir = statePath('dotfiles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'actual.toml'), 'old', { mode: 0o600 });
    fs.symlinkSync('actual.toml', join(dir, 'middle.toml'));
    fs.symlinkSync('middle.toml', join(dir, 'config.toml'));

    atomicWrite(join(dir, 'config.toml'), 'new');

    expect(fs.lstatSync(join(dir, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(dir, 'actual.toml'), 'utf8')).toBe('new');
    expect(fs.statSync(join(dir, 'actual.toml')).mode & 0o777).toBe(0o600);
  });

  it('resolves parent traversal after a symlinked directory physically', () => {
    const dir = statePath('physical-target');
    fs.mkdirSync(join(dir, 'folder/deep'), { recursive: true });
    fs.writeFileSync(join(dir, 'folder/actual.toml'), 'old');
    fs.symlinkSync('folder/deep', join(dir, 'alias'));
    fs.symlinkSync('alias/../actual.toml', join(dir, 'config.toml'));
    atomicWrite(join(dir, 'config.toml'), 'new');
    expect(fs.readFileSync(join(dir, 'folder/actual.toml'), 'utf8')).toBe('new');
    expect(fs.existsSync(join(dir, 'actual.toml'))).toBe(false);
  });

  it('preserves a dangling symlink while creating its target', () => {
    const dir = statePath('dangling');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync('nested/actual.toml', join(dir, 'config.toml'));
    atomicWrite(join(dir, 'config.toml'), 'new');
    expect(fs.lstatSync(join(dir, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(dir, 'nested/actual.toml'), 'utf8')).toBe('new');
  });

  it('flushes the temp file before rename and the directory afterward', () => {
    const events: string[] = [];
    const realRename = vi.mocked(fs.renameSync).getMockImplementation();
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      events.push('rename');
      return realRename?.(from, to);
    });
    atomicWrite(statePath('flushed.txt'), 'durable');
    expect(events).toEqual(['file', 'rename', 'directory']);
  });

  it('ignores directory fsync failure after a successful replacement', () => {
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('directory fsync unsupported');
    });
    const file = statePath('directory-flush.txt');
    expect(() => {
      atomicWrite(file, 'new');
    }).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.fsyncSync).toHaveBeenCalledTimes(2);
  });

  it.each(['write', 'rename', 'fsync'] as const)(
    'removes its temp file after %s fails',
    (failure) => {
      const file = statePath('failed-write.txt');
      fs.mkdirSync(dirname(file), { recursive: true });
      fs.writeFileSync(file, 'original');
      if (failure === 'write') {
        vi.mocked(fs.writeFileSync).mockImplementationOnce((path) => {
          fs.appendFileSync(path, 'partial');
          throw new Error('write failed');
        });
      } else if (failure === 'rename') {
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
          throw new Error('rename failed');
        });
      } else {
        vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
          throw new Error('fsync failed');
        });
      }
      expect(() => {
        atomicWrite(file, 'replacement');
      }).toThrow(`${failure} failed`);
      expect(fs.readFileSync(file, 'utf8')).toBe('original');
      expect(fs.readdirSync(dirname(file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    }
  );
});

describe('appendRecord fail-open', () => {
  it('returns a typed failure when its parent directory cannot be created', () => {
    const blocker = statePath('not-a-directory');
    fs.mkdirSync(dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, 'file');
    expect(
      appendRecord(join(blocker, 'record'), 'small', 'test', (_key, fn) => {
        fn();
      })
    ).toEqual({
      ok: false,
      error: 'append_failed',
    });
  });
});
