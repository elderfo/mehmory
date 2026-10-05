import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { commitPaths, ensureGitBaseline } from '../src/core/git.js';
import { peekWarnings } from '../src/core/errors.js';
import { initStore } from '../src/core/store.js';
import { lastCommit, dirtyPaths } from '../src/core/status.js';
import { resolveProjectKey, clearProjectKeyCache } from '../src/core/identity.js';
import { mehmoryHome, statePath } from '../src/core/home.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const actualCp = await vi.importActual<typeof cp>('node:child_process');
beforeEach(() => {
  vi.mocked(cp.execFileSync).mockReset().mockImplementation(actualCp.execFileSync);
});
afterEach(() => vi.restoreAllMocks());

function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  cp.execFileSync('git', ['init', dir], { stdio: 'pipe' });
  writeFileSync(join(dir, '.gitignore'), '.state/\n');
  writeFileSync(join(dir, 'note.md'), 'initial');
  cp.execFileSync('git', ['add', '.'], { cwd: dir });
  cp.execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
}

function timeoutOn(command: string, beforeThrow = (): void => {}): void {
  const actual = actualCp.execFileSync;
  vi.mocked(cp.execFileSync).mockImplementation((file, args, options) => {
    if (file === 'git' && args?.includes(command)) {
      beforeThrow();
      throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    return actual(file, args, options);
  });
}

describe('git runtime recovery', () => {
  it('lets a real git add taking over 500 ms complete', () => {
    repo(mehmoryHome());
    const executable = cp.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = statePath('slow-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in *" add "*) sleep 0.7;; esac\nexec "${executable}" "$@"\n`,
      { mode: 0o755 }
    );
    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = `${bin}:${saved ?? ''}`;
      writeFileSync(join(mehmoryHome(), 'note.md'), 'slow filesystem');
      expect(commitPaths(['note.md'], 'slow filesystem', mehmoryHome())).toEqual({ ok: true });
      expect(
        cp.execFileSync(executable, ['show', 'HEAD:note.md'], {
          cwd: mehmoryHome(),
          encoding: 'utf8',
        })
      ).toBe('slow filesystem');
    } finally {
      process.env['PATH'] = saved;
    }
  });
  it('uses SIGTERM and a 10 second budget for add, diff, and commit', () => {
    repo(mehmoryHome());
    writeFileSync(join(mehmoryHome(), 'note.md'), 'updated');
    vi.mocked(cp.execFileSync).mockClear();
    expect(commitPaths(['note.md'], 'updated', mehmoryHome())).toEqual({ ok: true });
    for (const command of ['add', 'diff', 'commit']) {
      const call = vi
        .mocked(cp.execFileSync)
        .mock.calls.find(([, args]) => args?.includes(command));
      expect(call?.[2]).toMatchObject({ timeout: 10000, killSignal: 'SIGTERM' });
    }
  });

  it.each(['rev-parse', 'add', 'diff', 'commit'])(
    'preserves a concurrent process lock during a timed-out %s and logs the remedy',
    async (command) => {
      repo(mehmoryHome());
      writeFileSync(join(mehmoryHome(), 'note.md'), 'changed');
      const lock = join(mehmoryHome(), '.git/index.lock');
      let owner: cp.ChildProcess | undefined;
      let exited: Promise<void> | undefined;
      timeoutOn(command, () => {
        owner = cp.spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { writeFileSync, openSync } from 'node:fs'; const fd = openSync(${JSON.stringify(lock)}, 'wx'); writeFileSync(fd, 'concurrent process'); setInterval(() => {}, 1000);`,
          ],
          { stdio: 'ignore' }
        );
        exited = new Promise((resolve) => {
          owner?.once('exit', () => {
            resolve();
          });
        });
        const deadline = Date.now() + 3000;
        while (!existsSync(lock) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        expect(readFileSync(lock, 'utf8')).toBe('concurrent process');
        const time = new Date(Date.now() + 1000);
        utimesSync(lock, time, time);
      });
      try {
        expect(commitPaths(['note.md'], 'timeout', mehmoryHome())).toEqual(
          command === 'commit' ? { ok: false, deferred: true } : { ok: false }
        );
        expect(readFileSync(lock, 'utf8')).toBe('concurrent process');
        expect(owner?.kill(0)).toBe(true);
        const log = readFileSync(statePath('errors.log'), 'utf8');
        expect(log).toContain(`E_GIT_COMMIT: git ${command} timed out`);
        expect(log).toContain('index.lock left untouched');
        expect(log).toContain(`only if no git process is running, remedy: rm '${lock}'`);
      } finally {
        owner?.kill('SIGTERM');
        await exited;
      }
    }
  );

  it.each(['add', 'commit'])(
    'warns once with the remedy when an old index.lock keeps %s deferred',
    (command) => {
      repo(mehmoryHome());
      writeFileSync(join(mehmoryHome(), 'note.md'), 'changed');
      const lock = join(mehmoryHome(), '.git/index.lock');
      const createOldLock = () => {
        writeFileSync(lock, 'older build');
        const time = new Date(Date.now() - 60000);
        utimesSync(lock, time, time);
      };
      if (command === 'add') createOldLock();
      else {
        vi.mocked(cp.execFileSync).mockImplementation((file, args, options) => {
          if (args?.includes('commit') && !existsSync(lock)) createOldLock();
          return actualCp.execFileSync(file, args, options);
        });
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(commitPaths(['note.md'], 'deferred', mehmoryHome())).toEqual({
          ok: false,
          deferred: true,
        });
      }
      expect(readFileSync(lock, 'utf8')).toBe('older build');
      const log = readFileSync(statePath('errors.log'), 'utf8');
      expect(log.split('\n').filter(Boolean)).toHaveLength(1);
      expect(log).toContain('E_GIT_COMMIT: index.lock is older than 30000 ms; left untouched');
      expect(log).toContain(`only if no git process is running, remedy: rm '${lock}'`);
      expect(peekWarnings()).toEqual([
        `E_GIT_COMMIT (informational, 1 occurrences): see ${statePath('errors.log')}`,
      ]);
    }
  );

  it('suppresses signature display in store history despite ambient configuration', () => {
    repo(mehmoryHome());
    cp.execFileSync('git', ['config', 'log.showSignature', 'true'], { cwd: mehmoryHome() });
    vi.mocked(cp.execFileSync).mockClear();
    expect(lastCommit()).toContain('initial');
    const call = vi.mocked(cp.execFileSync).mock.calls.find(([, args]) => args?.includes('log'));
    expect(call?.[1]).toContain('--no-show-signature');
  });

  it('never removes a lock older than the timed-out call', () => {
    repo(mehmoryHome());
    const lock = join(mehmoryHome(), '.git/index.lock');
    writeFileSync(lock, 'other process');
    const time = new Date(Date.now() - 60000);
    utimesSync(lock, time, time);
    timeoutOn('add');
    expect(commitPaths(['note.md'], 'timeout', mehmoryHome())).toEqual({ ok: false });
    expect(readFileSync(lock, 'utf8')).toBe('other process');
    expect(readFileSync(statePath('errors.log'), 'utf8')).toContain('git add timed out');
  });

  it('does not mistake a timed-out repository probe for a missing repository', () => {
    repo(mehmoryHome());
    timeoutOn('rev-parse');
    expect(ensureGitBaseline(mehmoryHome())).toEqual({ ok: false });
    expect(commitPaths(['note.md'], 'timeout', mehmoryHome())).toEqual({ ok: false });
    const log = readFileSync(statePath('errors.log'), 'utf8');
    expect(log).toContain('git rev-parse timed out');
    expect(log).not.toContain('Not in a git repository');
  });

  it('bounds init, config, status, log, and project identity git children', () => {
    expect(initStore().ok).toBe(true);
    expect(ensureGitBaseline(mehmoryHome())).toEqual({ ok: true });
    lastCommit();
    dirtyPaths();
    clearProjectKeyCache();
    resolveProjectKey(mehmoryHome());
    for (const [, , options] of vi.mocked(cp.execFileSync).mock.calls) {
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.killSignal).toBe('SIGTERM');
    }
    const probes = vi
      .mocked(cp.execFileSync)
      .mock.calls.filter(([, args]) => args?.includes('rev-parse'));
    for (const [, , options] of probes) expect(options?.timeout).toBe(500);
  });
});

describe('all store git calls are isolated', () => {
  it('initializes only the store and never edits an inherited user repository config', () => {
    const user = statePath('user');
    repo(user);
    cp.execFileSync('git', ['config', '--local', 'commit.gpgsign', 'true'], { cwd: user });
    const config = readFileSync(join(user, '.git/config'), 'utf8');
    const saved = { ...process.env };
    try {
      process.env['GIT_DIR'] = join(user, '.git');
      process.env['GIT_WORK_TREE'] = user;
      expect(initStore().ok).toBe(true);
      expect(existsSync(join(mehmoryHome(), '.git/config'))).toBe(true);
      expect(readFileSync(join(user, '.git/config'), 'utf8')).toBe(config);
    } finally {
      process.env = saved;
    }
  });

  it('reports store history and dirty paths rather than an inherited user repository', () => {
    const user = statePath('user');
    repo(user);
    writeFileSync(join(user, 'note.md'), 'user history');
    cp.execFileSync('git', ['commit', '-am', 'user history'], { cwd: user, stdio: 'pipe' });
    repo(mehmoryHome());
    writeFileSync(join(user, 'private.txt'), 'private');
    writeFileSync(join(mehmoryHome(), 'memory.txt'), 'memory');
    const saved = { ...process.env };
    try {
      process.env['GIT_DIR'] = join(user, '.git');
      process.env['GIT_WORK_TREE'] = user;
      expect(dirtyPaths()).toEqual(['?? memory.txt']);
      expect(lastCommit()).toContain('initial');
      const storeHead = cp
        .execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: mehmoryHome(),
          env: saved,
          encoding: 'utf8',
        })
        .trim();
      expect(lastCommit()?.split(' ')[0]).toBe(storeHead);
    } finally {
      process.env = saved;
    }
  });

  it('disables repo-local executable fsmonitor configuration', () => {
    repo(mehmoryHome());
    const marker = statePath('fsmonitor-ran');
    const monitor = statePath('fsmonitor');
    mkdirSync(statePath(), { recursive: true });
    writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
    cp.execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: mehmoryHome() });
    writeFileSync(join(mehmoryHome(), 'note.md'), 'updated');
    expect(commitPaths(['note.md'], 'updated', mehmoryHome())).toEqual({ ok: true });
    dirtyPaths();
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ])('ignores %s while retaining literal purge pathspecs', (name) => {
    repo(mehmoryHome());
    const saved = process.env[name];
    try {
      process.env[name] = '1';
      vi.mocked(cp.execFileSync).mockClear();
      writeFileSync(join(mehmoryHome(), 'note.md'), 'updated');
      expect(commitPaths([':(top,literal)note.md'], 'updated', mehmoryHome(), true)).toEqual({
        ok: true,
      });
      for (const [, , options] of vi.mocked(cp.execFileSync).mock.calls) {
        expect(options?.env?.[name]).toBeUndefined();
      }
      expect(
        cp.execFileSync('git', ['show', 'HEAD:note.md'], { cwd: mehmoryHome(), encoding: 'utf8' })
      ).toBe('updated');
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = saved;
    }
  });

  it('preserves discovery ceilings and gives git children a C locale', () => {
    repo(mehmoryHome());
    const saved = { ...process.env };
    try {
      process.env['GIT_CEILING_DIRECTORIES'] = statePath();
      process.env['LC_ALL'] = 'fr_FR.UTF-8';
      vi.mocked(cp.execFileSync).mockClear();
      expect(commitPaths(['note.md'], 'unchanged', mehmoryHome())).toEqual({ ok: true });
      for (const [, , options] of vi.mocked(cp.execFileSync).mock.calls) {
        expect(options?.env?.['GIT_CEILING_DIRECTORIES']).toBe(statePath());
        expect(options?.env?.['LC_ALL']).toBe('C');
      }
    } finally {
      process.env = saved;
    }
  });

  it('keeps the caller repository environment for project identity discovery', () => {
    const user = statePath('user');
    repo(user);
    cp.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/intended.git'], {
      cwd: user,
    });
    const saved = { ...process.env };
    try {
      process.env['GIT_DIR'] = join(user, '.git');
      process.env['GIT_WORK_TREE'] = user;
      clearProjectKeyCache();
      expect(resolveProjectKey(mehmoryHome())).toBe('github.com/owner/intended');
    } finally {
      process.env = saved;
      clearProjectKeyCache();
    }
  });
});
