import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { statePath } from '../src/core/home.js';
import { pendingWarnings, peekWarnings, recordWarning } from '../src/core/errors.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
afterEach(() => vi.restoreAllMocks());

const actualFs = await vi.importActual<typeof fs>('node:fs');

const expected = (): string[] => [
  `E_LOCK_TIMEOUT (informational, 1 occurrences): see ${statePath('errors.log')}`,
];

describe('warning drain recovery', () => {
  it.each(['warnings.json', 'warning-records/broken.json'])(
    'discards invalid JSON in %s instead of restoring it forever',
    (name) => {
      fs.mkdirSync(statePath('warning-records'), { recursive: true });
      const path = statePath(name);
      fs.writeFileSync(path, '{half-written');
      expect(pendingWarnings()).toEqual([]);
      expect(fs.existsSync(path)).toBe(false);
      expect(fs.readdirSync(statePath('warning-records'))).toEqual([]);
      expect(fs.readdirSync(statePath()).filter((file) => file.includes('.drain-'))).toEqual([]);
    }
  );

  it.each(['warnings.json', 'warning-records/valid.json'])(
    'reads unclaimed %s when rename is denied',
    (name) => {
      fs.mkdirSync(statePath('warning-records'), { recursive: true });
      const path = statePath(name);
      fs.writeFileSync(
        path,
        JSON.stringify({ code: 'E_LOCK_TIMEOUT', lastTime: Date.now(), count: 1 })
      );
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw Object.assign(new Error('read-only state'), { code: 'EACCES' });
      });
      expect(pendingWarnings()).toEqual(expected());
      expect(fs.existsSync(path)).toBe(true);
    }
  );

  it('restores a claimed warning after a transient read I/O failure', () => {
    recordWarning('E_LOCK_TIMEOUT');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('I/O error'), { code: 'EIO' });
    });
    expect(pendingWarnings()).toEqual([]);
    expect(peekWarnings()).toEqual(expected());
    expect(pendingWarnings()).toEqual(expected());
  });

  it('dates claims from acquisition rather than the warning publication time', () => {
    recordWarning('E_LOCK_TIMEOUT');
    const name = fs.readdirSync(statePath('warning-records'))[0];
    if (!name) throw new Error('missing record');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(statePath('warning-records', name), old, old);
    vi.mocked(fs.readFileSync).mockImplementationOnce((path, options) => {
      expect(peekWarnings()).toEqual([]);
      return actualFs.readFileSync(path, options);
    });
    expect(pendingWarnings()).toEqual(expected());
  });

  it.each(['warnings.json', 'warning-records/valid.json'])(
    'recovers and sweeps stale %s drain claims but leaves recent claims alone',
    (name) => {
      fs.mkdirSync(statePath('warning-records'), { recursive: true });
      const old = statePath(`${name}.drain-${randomUUID()}`);
      const recent = statePath(`${name}.drain-${randomUUID()}`);
      const contents = JSON.stringify({ code: 'E_LOCK_TIMEOUT', lastTime: Date.now(), count: 1 });
      fs.writeFileSync(old, contents);
      fs.writeFileSync(recent, contents);
      const time = new Date(Date.now() - 61000);
      fs.utimesSync(old, time, time);
      expect(pendingWarnings()).toEqual(expected());
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.readFileSync(recent, 'utf8')).toBe(contents);
    }
  );
});
