/** Fail-open fixtures for all five hooks (criterion 15). */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import {
  errorsLog,
  keyFor,
  paths,
  runHook,
  seedStore,
  writeTranscript,
  type HookName,
} from './hook-fixture.js';
import { mehmoryHome } from '../src/core/home.js';
import { sessionStatePath, updateSessionState } from '../src/core/session.js';
import { loadConfig } from '../src/core/config.js';

/** The Stop capture threshold now comes from config (`stop.capture_threshold`).
 * Read inside the test, not at import time — MEHMORY_HOME is only hermetic once
 * setup.ts's beforeEach has run. */
function stopThreshold(): number {
  return loadConfig().stop.capture_threshold;
}

const HOOKS: HookName[] = [
  'session-start',
  'user-prompt-submit',
  'stop',
  'pre-compact',
  'session-end',
];

/** Fixture stdin per hook, chosen so every hook attempts a write. */
function inputFor(hook: HookName, transcript: string): Record<string, unknown> {
  const base = { session_id: 's1', transcript_path: transcript };
  if (hook === 'session-start') return { ...base, source: 'startup' };
  if (hook === 'user-prompt-submit') return { ...base, prompt: 'remember: a durable decision' };
  return base;
}

/** Stop only captures at the threshold; put it there so its write path is exercised. */
function primeStop(hook: HookName): void {
  if (hook !== 'stop') return;
  updateSessionState('s1', state => ({ ...state, stop_count: stopThreshold() - 1 }));
}

describe('hooks fail open', () => {
  let cwd: string;
  let key: string;
  let transcript: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    transcript = writeTranscript([{ text: 'We decided to fail open everywhere.' }]);
  });

  for (const hook of HOOKS) {
    it(`${hook}: corrupt session state resets and logs`, () => {
      seedStore(key);
      mkdirSync(join(mehmoryHome(), '.state'), { recursive: true });
      writeFileSync(sessionStatePath('s1'), '{ this is not json');

      const run = runHook(hook, inputFor(hook, transcript), { cwd });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      if (run.stdout) expect(() => JSON.parse(run.stdout) as unknown).not.toThrow();
      expect(errorsLog()).toContain('E_SESSION_STATE');
    });

    it(`${hook}: an absent transcript is survivable`, () => {
      seedStore(key);
      primeStop(hook);

      const run = runHook(hook, inputFor(hook, '/nonexistent/transcript.jsonl'), { cwd });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      if (run.stdout) expect(() => JSON.parse(run.stdout) as unknown).not.toThrow();
    });

    it(`${hook}: a store path that is a file logs and exits 0`, () => {
      seedStore(key);
      rmSync(join(mehmoryHome(), 'global'), { recursive: true, force: true });
      writeFileSync(join(mehmoryHome(), 'global'), 'not a directory');
      rmSync(paths(key).projectDir, { recursive: true, force: true });
      writeFileSync(paths(key).projectDir, 'not a directory');
      primeStop(hook);

      const run = runHook(hook, inputFor(hook, transcript), { cwd });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(errorsLog()).not.toBe('');
    });

    it(`${hook}: stdin without a session_id is a logged no-op`, () => {
      seedStore(key);
      const input = inputFor(hook, transcript);
      delete input['session_id'];

      const run = runHook(hook, input, { cwd });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe('');
      expect(existsSync(join(mehmoryHome(), '.state', '.json'))).toBe(false);
      expect(errorsLog()).toContain('E_SESSION_STATE');
    });

    it(`${hook}: a corrupt store .git is survivable`, () => {
      seedStore(key);
      rmSync(join(mehmoryHome(), '.git'), { recursive: true, force: true });
      writeFileSync(join(mehmoryHome(), '.git'), 'not a git directory');
      primeStop(hook);

      const run = runHook(hook, inputFor(hook, transcript), { cwd });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      if (hook === 'session-end') expect(errorsLog()).toContain('E_GIT_COMMIT');
    });
  }
});
