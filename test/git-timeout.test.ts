import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { commitPaths, ensureGitBaseline } from '../src/core/git.js';
import { peekWarnings } from '../src/core/errors.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('bounds every git invocation and disables all hooks', () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) =>
    Buffer.from(args?.includes('diff') ? 'note.md\n' : '')
  );
  expect(ensureGitBaseline(process.cwd())).toEqual({ ok: true });
  expect(commitPaths(['note.md'], 'test', process.cwd(), true)).toEqual({ ok: true });
  expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args?.[6])).toEqual([
    'rev-parse',
    'rev-parse',
    'rev-parse',
    'rev-parse',
    'add',
    'diff',
    'commit',
  ]);
  for (const [command, args, options] of vi.mocked(execFileSync).mock.calls) {
    expect(command).toBe('git');
    expect(args?.slice(0, 6)).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.useBuiltinFSMonitor=false',
    ]);
    expect(options?.timeout).toBe(args?.includes('rev-parse') ? 500 : 10000);
    expect(options?.killSignal).toBe('SIGTERM');
    if (args?.includes('commit')) expect(args).toContain('--no-verify');
  }
});

it('bounds initialization and both attempts after index.lock contention', () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes('--verify')) throw new Error('no HEAD');
    if (args?.includes('commit')) throw new Error('index.lock exists');
    return Buffer.from(args?.includes('diff') ? 'note.md\n' : '');
  });
  expect(ensureGitBaseline(process.cwd())).toEqual({ ok: false, deferred: true });
  const calls = vi.mocked(execFileSync).mock.calls;
  expect(calls.filter(([, args]) => args?.includes('commit'))).toHaveLength(2);
  for (const [, args, options] of calls) {
    expect(options?.timeout).toBe(args?.includes('rev-parse') ? 500 : 10000);
    expect(options?.killSignal).toBe('SIGTERM');
  }
});

it('treats a concurrent commit leaving nothing to commit as success without warnings', () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes('commit')) {
      throw Object.assign(new Error('git exited 1'), {
        status: 1,
        stdout: Buffer.from('nothing to commit, working tree clean\n'),
      });
    }
    return Buffer.from(args?.includes('diff') ? 'note.md\n' : '');
  });
  expect(commitPaths(['note.md'], 'test', process.cwd())).toEqual({ ok: true });
  expect(peekWarnings()).toEqual([]);
});
