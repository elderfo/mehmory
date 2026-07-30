/** SessionEnd fixture tests (criteria 13, 16). */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import {
  keyFor,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeTranscript,
} from './hook-fixture.js';
import { mehmoryHome, statePath } from '../src/core/home.js';
import { sessionStatePath } from '../src/core/session.js';

describe('SessionEnd hook', () => {
  let cwd: string;
  let key: string;
  let transcript: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
    transcript = writeTranscript([{ text: 'We decided to ship the plugin unbundled.' }]);
  });

  it('enqueues the final delta, logs, commits, and deletes its session state', () => {
    const run = runHook('session-end', { session_id: 's1', transcript_path: transcript }, { cwd });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');

    const queued = readdirSync(statePath('queue')).filter(f => f.endsWith('.json'));
    expect(queued).toHaveLength(1);

    expect(readIfPresent(paths(key).log)).toContain('session-end');
    expect(existsSync(sessionStatePath('s1'))).toBe(false);

    const log = execFileSync('git', ['-C', mehmoryHome(), 'log', '--oneline'], {
      encoding: 'utf-8',
    });
    expect(log).toContain('session s1 ended');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'SessionEnd' });
  });

  it('hands the delta to the next SessionStart, which applies and retires the job', () => {
    runHook('session-end', { session_id: 's1', transcript_path: transcript }, { cwd });

    runHook('session-start', { session_id: 's2', source: 'startup' }, { cwd });

    expect(readIfPresent(paths(key).inbox)).toContain('unbundled');
    const jsonIn = (dir: string): string[] =>
      existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    expect(jsonIn(statePath('queue'))).toEqual([]);
    expect(jsonIn(join(statePath('queue'), 'claimed'))).toEqual([]);
  });
});
