import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  createFakeClaudeHome,
  encodeClaudeProjectDir,
  hermeticEnv,
  isHermeticHome,
} from './helpers.js';

/**
 * Criterion 21: nothing reads or writes the real `~/.mehmory` or `~/.claude`. The
 * in-process half is enforced by the setup file's afterEach; this covers the half that
 * guard cannot see — the environment handed to a spawned hook bundle.
 */
describe('hermetic subprocess env', () => {
  it('rejects the real store and anything outside the temp dir', () => {
    expect(isHermeticHome(join(homedir(), '.mehmory'))).toBe(false);
    expect(isHermeticHome('/var/lib/somewhere')).toBe(false);
    expect(isHermeticHome(undefined)).toBe(false);
    expect(isHermeticHome(process.env.MEHMORY_HOME)).toBe(true);
  });

  it('redirects MEHMORY_HOME and HOME for the child process', () => {
    const env = hermeticEnv();
    const output = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify([process.env.MEHMORY_HOME, process.env.HOME]))'],
      { env, encoding: 'utf-8' }
    );

    const [childMehmoryHome, childHome] = JSON.parse(output) as [string, string];
    expect(childMehmoryHome).toBe(process.env.MEHMORY_HOME);
    expect(childHome).toBe(process.env.MEHMORY_HOME);
    expect(isHermeticHome(childHome)).toBe(true);
  });

  it('passes extra variables through', () => {
    expect(hermeticEnv({ CLAUDE_PROJECT_DIR: '/tmp/x' })['CLAUDE_PROJECT_DIR']).toBe('/tmp/x');
  });

  // The child env is the only guard a spawned CLI gets: the in-process MEHMORY_HOME
  // check in setup.ts cannot see a child, and `extra` is applied last.
  it('refuses to hand a child a HOME or MEHMORY_HOME outside the temp dir', () => {
    expect(() => hermeticEnv({ HOME: homedir() })).toThrow(/not a temp dir/);
    expect(() => hermeticEnv({ MEHMORY_HOME: join(homedir(), '.mehmory') })).toThrow(
      /not a temp dir/
    );
  });
});

describe('fake ~/.claude transcript tree', () => {
  it('encodes a project path the way Claude Code names its directories', () => {
    expect(encodeClaudeProjectDir('/home/u/dev/my.repo')).toBe('-home-u-dev-my-repo');
  });

  it('creates projects/<encoded>/<session>.jsonl under a hermetic HOME', () => {
    const home = createFakeClaudeHome({
      '/home/u/dev/repo': { 'sess-1': ['{"type":"message"}'] },
      '/home/u/dev/gone': {},
    });

    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir('/home/u/dev/repo'));
    expect(readFileSync(join(dir, 'sess-1.jsonl'), 'utf-8')).toBe('{"type":"message"}\n');
    // A project with no sessions still gets its directory — the `unresolvable` case.
    expect(
      existsSync(join(home, '.claude', 'projects', encodeClaudeProjectDir('/home/u/dev/gone')))
    ).toBe(true);
    expect(isHermeticHome(home)).toBe(true);
    expect(hermeticEnv({ HOME: home })['HOME']).toBe(home);
  });
});
