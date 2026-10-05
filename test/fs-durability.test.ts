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
  it('replaces a destination symlink without touching its outside target', () => {
    const dir = statePath('store');
    const target = statePath('outside.bashrc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, 'user configuration', { mode: 0o600 });
    const destination = join(dir, 'index.md');
    fs.symlinkSync(target, destination);

    atomicWrite(destination, 'memory index');

    expect(fs.readFileSync(target, 'utf8')).toBe('user configuration');
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('memory index');
  });

  it('replaces a dangling symlink without creating its target parent', () => {
    const dir = statePath('store');
    const targetParent = statePath('outside-missing');
    fs.mkdirSync(dir, { recursive: true });
    const destination = join(dir, 'index.md');
    fs.symlinkSync(join(targetParent, 'index.md'), destination);
    atomicWrite(destination, 'memory index');
    expect(fs.existsSync(targetParent)).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('memory index');
  });

  it('follows a trusted symlinked parent directory when replacing a file', () => {
    const parent = statePath('linked-directory');
    const target = statePath('trusted-directory');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, parent);
    atomicWrite(join(parent, 'index.md'), 'memory index');
    expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(target, 'index.md'), 'utf8')).toBe('memory index');
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
