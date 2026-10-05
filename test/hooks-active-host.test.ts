import { sessionState, changeSession, stateFileFor } from './session-fixture.js';
/** MEHMORY_ACTIVE_HOST (A30): one capturing harness per process tree, asserted through the
 * built bundles like every other hook suite. */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createTempDir } from './helpers.js';
import {
  additionalContext,
  keyFor,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeTranscript,
} from './hook-fixture.js';
import { loadConfig } from '../src/core/config.js';


const REMEMBER = 'remember: staging needs the VPN';

describe('MEHMORY_ACTIVE_HOST', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, {
      project: '---\nupdated: 2026-07-01\ntype: entity\n---\n\n# Project\n\n- stack: rust\n',
    });
  });

  const sessionStart = (host: string, env: Record<string, string> = {}): ReturnType<typeof runHook> =>
    runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd, args: [host], env });

  const remember = (host: string, env: Record<string, string> = {}): ReturnType<typeof runHook> =>
    runHook('user-prompt-submit', { session_id: 's1', prompt: REMEMBER }, { cwd, args: [host], env });

  /** Stop at the capture threshold: one call away from filing the transcript and blocking. */
  const stopAtThreshold = (host: string, env: Record<string, string> = {}): ReturnType<typeof runHook> => {
    const transcript = writeTranscript([{ text: 'We decided to use fly.io for deploys.' }]);
    changeSession('s1', state => ({ ...state, stop_count: loadConfig().stop.capture_threshold - 1 }));
    return runHook('stop', { session_id: 's1', transcript_path: transcript }, { cwd, args: [host], env });
  };

  describe('naming another host silences claude-code', () => {
    const env = { MEHMORY_ACTIVE_HOST: 'pi' };

    it('injects nothing at SessionStart and says why on the stats line, under its project', () => {
      const run = sessionStart('claude-code', env);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(existsSync(stateFileFor('s1'))).toBe(false);
      expect(statsLines().at(-1)).toMatchObject({
        project: key,
        hook: 'SessionStart',
        host: 'claude-code',
        suppressed: 'active_host',
      });
    });

    it('does not capture a remember: prompt', () => {
      const run = remember('claude-code', env);

      expect(run.stdout).toBe('');
      expect(readIfPresent(paths(key).inbox)).toBe('');
    });

    it('emits {} at Stop without capturing or counting', () => {
      const run = stopAtThreshold('claude-code', env);

      expect(run.stdout).toBe('{}');
      expect(readIfPresent(paths(key).inbox)).toBe('');
      expect(sessionState('s1').stop_count).toBe(loadConfig().stop.capture_threshold - 1);
      expect(statsLines().at(-1)).toMatchObject({ hook: 'Stop', host: 'claude-code', suppressed: 'active_host' });
    });
  });

  describe('naming this host, or nothing, leaves claude-code unchanged', () => {
    for (const [label, env] of [
      ['MEHMORY_ACTIVE_HOST=claude-code', { MEHMORY_ACTIVE_HOST: 'claude-code' }],
      ['unset', {}],
      ['a typo', { MEHMORY_ACTIVE_HOST: 'claude' }],
    ] as const) {
      it(`injects, captures, and blocks with ${label}`, () => {
        const start = sessionStart('claude-code', env);
        expect(additionalContext(start)).toContain('stack: rust');
        expect(statsLines().at(-1)).toMatchObject({ project: key, hook: 'SessionStart', host: 'claude-code' });
        expect(statsLines().at(-1)?.['suppressed']).toBeUndefined();

        expect(additionalContext(remember('claude-code', env))).toBe('mehmory: captured to inbox');
        expect(readIfPresent(paths(key).inbox)).toContain('staging needs the VPN');

        expect(additionalContext(stopAtThreshold('claude-code', env))).toContain('/mehmory:remember');
        expect(readIfPresent(paths(key).inbox)).toContain('fly.io');
      });
    }
  });

  it('none silences pi too', () => {
    const run = remember('pi', { MEHMORY_ACTIVE_HOST: 'none' });

    expect(run.stdout).toBe('');
    expect(readIfPresent(paths(key).inbox)).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'UserPromptSubmit', host: 'pi', suppressed: 'active_host' });
  });

  it('lets the named host through', () => {
    const run = remember('pi', { MEHMORY_ACTIVE_HOST: 'pi' });

    expect(additionalContext(run)).toBe('mehmory: captured to inbox');
    expect(readIfPresent(paths(key).inbox)).toContain('staging needs the VPN');
  });
});
