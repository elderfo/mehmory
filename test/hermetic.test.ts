import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv, isHermeticHome } from './helpers.js';

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
});
