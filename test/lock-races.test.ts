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

  it('serializes reclaimers between the identity recheck and unlink', () => {
    const path = staleLock('reclaim-race', '99999:old');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const remove = fs.remove;
    const operation = vi.fn(() => 'held');
    let deletedLiveLock = false;
    vi.spyOn(fs, 'remove').mockImplementationOnce((target) => {
      expect(target).toBe(path);
      const competing = withProjectLock(
        'reclaim-race',
        () => {
          operation();
          remove(target);
          deletedLiveLock = !existsSync(path);
          return 'competing';
        },
        1,
        0,
        false
      );
      if (competing === undefined) remove(target);
    });

    expect(withProjectLock('reclaim-race', operation, 1, 0, false)).toBe('held');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(deletedLiveLock).toBe(false);
    expect(existsSync(`${path}.reclaim`)).toBe(false);
  });

  it('does not reclaim while another reclaimer holds a fresh guard', () => {
    const path = staleLock('guarded', '', 5 * 60 * 1000 + 1000);
    writeFileSync(`${path}.reclaim`, 'competing:guard');
    const operation = vi.fn(() => 'ran');
    expect(withProjectLock('guarded', operation, 1, 0, false)).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(0);
    expect(readFileSync(path, 'utf-8')).toBe('');
    expect(readFileSync(`${path}.reclaim`, 'utf-8')).toBe('competing:guard');
  });

  it('serializes recovery of an abandoned reclaim guard', () => {
    const path = staleLock('abandoned-guard', '', 5 * 60 * 1000 + 1000);
    const guard = `${path}.reclaim`;
    writeFileSync(guard, 'abandoned');
    const time = (Date.now() - 40000) / 1000;
    utimesSync(guard, time, time);
    const remove = fs.remove;
    const operation = vi.fn(() => 'held');
    vi.spyOn(fs, 'remove').mockImplementationOnce((target) => {
      expect(target).toBe(guard);
      expect(withProjectLock('abandoned-guard', operation, 1, 0, false)).toBeUndefined();
      remove(target);
    });

    expect(withProjectLock('abandoned-guard', operation, 1, 0, false)).toBe('held');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(guard)).toBe(false);
    expect(existsSync(`${guard}.reclaim`)).toBe(false);
  });

  it('preserves a replaced guard while recovering an abandoned guard', () => {
    const path = staleLock('replaced-guard', '', 5 * 60 * 1000 + 1000);
    const guard = `${path}.reclaim`;
    writeFileSync(guard, 'abandoned');
    const time = (Date.now() - 40000) / 1000;
    utimesSync(guard, time, time);
    const read = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation((target) => {
      const contents = read(target);
      if (target === guard && contents === 'abandoned') {
        writeFileSync(guard, 'fresh:guard');
      }
      return contents;
    });
    const operation = vi.fn(() => 'ran');

    expect(withProjectLock('replaced-guard', operation, 1, 0, false)).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(0);
    expect(readFileSync(guard, 'utf-8')).toBe('fresh:guard');
    expect(existsSync(`${guard}.reclaim`)).toBe(false);
  });

  it('releases the reclaim guard even if unlink fails', () => {
    const path = staleLock('unlink-error', '', 5 * 60 * 1000 + 1000);
    vi.spyOn(fs, 'remove').mockImplementationOnce(() => {
      throw new Error('unlink failed');
    });
    const operation = vi.fn(() => 'ran');
    expect(withProjectLock('unlink-error', operation, 0, 0, false)).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(0);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.reclaim`)).toBe(false);
  });

  it('does not reclaim a live holder just below the five-minute cap', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const owner = `${String(process.pid)}:holder`;
    const path = staleLock('under-cap', owner, 5 * 60 * 1000 - 1);
    const operation = vi.fn(() => 'ran');
    expect(withProjectLock('under-cap', operation, 1, 0, false)).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(0);
    expect(readFileSync(path, 'utf-8')).toBe(owner);
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
