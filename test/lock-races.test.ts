import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';
import { withProjectLock } from '../src/core/lock.js';

function staleLock(key: string, owner: string, age = 40000): string {
  const path = join(statePath('locks'), `${key}.lock`);
  mkdirSync(statePath('locks'), { recursive: true });
  writeFileSync(path, owner);
  const time = (Date.now() - age) / 1000;
  utimesSync(path, time, time);
  return path;
}

afterEach(() => vi.restoreAllMocks());

describe('project lock races', () => {
  it('preserves a fresh lock acquired while inspecting a stale owner', () => {
    const path = staleLock('replacement', '99999:old');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      rmSync(path);
      writeFileSync(path, `${String(process.pid)}:fresh`);
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const operation = vi.fn(() => 'ran');
    expect(withProjectLock('replacement', operation, 1, 1, false)).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(0);
    expect(readFileSync(path, 'utf-8')).toBe(`${String(process.pid)}:fresh`);
  });

  it('waits the retry interval when a stale owner is still alive', () => {
    staleLock('alive', `${String(process.pid)}:alive`);
    const start = performance.now();
    expect(withProjectLock('alive', () => 'ran', 2, 10, false)).toBeUndefined();
    expect(performance.now() - start).toBeGreaterThanOrEqual(19);
  });

  it('reclaims a lock older than five minutes even when its PID is alive', () => {
    staleLock('reused', `${String(process.pid)}:reused`, 5 * 60 * 1000 + 1000);
    expect(withProjectLock('reused', () => 'locked', 1, 1, false)).toBe('locked');
  });

  it.each(['EPERM', 'EIO'])('keeps a stale lock when probing its owner returns %s', (code) => {
    const path = staleLock(`probe-${code}`, '99999:owner');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('probe failed'), { code });
    });
    expect(withProjectLock(`probe-${code}`, () => 'ran', 1, 1, false)).toBeUndefined();
    expect(readFileSync(path, 'utf-8')).toBe('99999:owner');
  });

  it('reclaims a stale lock whose owner no longer exists', () => {
    staleLock('dead', '99999:owner');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(withProjectLock('dead', () => 'locked', 1, 1, false)).toBe('locked');
  });

  it('retains the shared locks directory after releasing the last lock', () => {
    expect(withProjectLock('directory', () => 'locked')).toBe('locked');
    expect(existsSync(statePath('locks'))).toBe(true);
  });

  it('recreates the locks directory before retrying exclusive creation', () => {
    const create = fs.createLockExclusive;
    vi.spyOn(fs, 'createLockExclusive').mockImplementationOnce((path, owner) => {
      rmSync(statePath('locks'), { recursive: true });
      return create(path, owner);
    });
    expect(withProjectLock('vanished', () => 'locked', 1, 1, false)).toBe('locked');
  });
});
