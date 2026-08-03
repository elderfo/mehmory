/** Stop fixture tests (criteria 11, 14, 16, 19). */

import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach } from 'vitest';
import { createTempDir, hermeticEnv } from './helpers.js';
import {
  keyFor,
  outputJson,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeTranscript,
} from './hook-fixture.js';
import { readSessionState, updateSessionState } from '../src/core/session.js';
import { loadConfig } from '../src/core/config.js';

/** The Stop capture threshold now comes from config (`stop.capture_threshold`).
 * Read inside the test, not at import time — MEHMORY_HOME is only hermetic once
 * setup.ts's beforeEach has run. */
function stopThreshold(): number {
  return loadConfig().stop.capture_threshold;
}

const TRANSCRIPT = [
  { text: 'We decided to use fly.io for deploys.' },
  { text: 'Actually the rollback step was wrong; redeploy the previous release instead.' },
  { text: 'The staging key AKIAIOSFODNN7EXAMPLE is in the env file.' },
];

/** Put the session one Stop away from the capture threshold. */
function primeCounter(sessionId: string): void {
  updateSessionState(sessionId, state => ({
    ...state,
    stop_count: stopThreshold() - 1,
  }));
}

describe('Stop hook', () => {
  let cwd: string;
  let key: string;
  let transcript: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
    transcript = writeTranscript(TRANSCRIPT);
  });

  it('stays silent below the threshold but counts the stop', () => {
    const run = runHook(
      'stop',
      { session_id: 's1', transcript_path: transcript },
      { cwd }
    );

    expect(run.status).toBe(0);
    // `{}`, not silence: Codex parses Stop output on every Stop, and the
    // below-threshold Stop is the most frequent one (D9).
    expect(run.stdout).toBe('{}');
    expect(readSessionState('s1').stop_count).toBe(1);
  });

  it('captures and blocks once at the threshold', () => {
    primeCounter('s1');

    const run = runHook('stop', { session_id: 's1', transcript_path: transcript }, { cwd });
    const output = outputJson(run);

    expect(run.status).toBe(0);
    expect(output['decision']).toBe('block');
    const reason = String(output['reason']);
    expect(reason).toContain('inbox-tx.mjs append');
    expect(reason).toContain('/mehmory:remember');
    // The model must never be told to hand-write the entry serialization (A15, U6).
    expect(reason).not.toContain('<!--mehmory');
    // A block mid-dialogue is disruptive enough without the model reciting every entry
    // back and re-summarizing the session on top of it.
    expect(reason).toContain('Save silently');

    const inbox = readIfPresent(paths(key).inbox);
    expect(inbox).toContain('fly.io');
    expect(inbox).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(readSessionState('s1').stop_count).toBe(0);
    expect(statsLines().at(-1)).toMatchObject({ hook: 'Stop' });
  });

  it('embeds an inbox-tx invocation that actually runs', () => {
    primeCounter('s1');
    const reason = String(
      outputJson(runHook('stop', { session_id: 's1', transcript_path: transcript }, { cwd }))[
        'reason'
      ]
    );

    // Pull the literal command out of the reason and run it, placeholder filled in.
    // The learning carries an apostrophe: the embedded form must survive model prose
    // that contains a single quote, which the old `echo '<json>' |` form did not.
    const match = /node \S+inbox-tx\.mjs append <<'JSON'\n[\s\S]*?\nJSON\n/.exec(reason);
    expect(match).not.toBeNull();
    const learning = "deploys need the VPN, don't repeat this";
    const command = String(match?.[0]).replace('<the learning>', learning);

    const run = spawnSync('sh', ['-c', command], { env: hermeticEnv(), encoding: 'utf-8' });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ appended: 1 });
    expect(readIfPresent(paths(key).inbox)).toContain(learning);
  });

  it('does not re-block on the next stop after a capture', () => {
    primeCounter('s1');
    runHook('stop', { session_id: 's1', transcript_path: transcript }, { cwd });

    const next = runHook('stop', { session_id: 's1', transcript_path: transcript }, { cwd });

    expect(next.stdout).toBe('{}');
    expect(readSessionState('s1').stop_count).toBe(1);
  });

  it('is a no-op when stop_hook_active is set', () => {
    primeCounter('s1');

    const run = runHook(
      'stop',
      { session_id: 's1', transcript_path: transcript, stop_hook_active: true },
      { cwd }
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{}');
    expect(readSessionState('s1').stop_count).toBe(stopThreshold() - 1);
  });

  it('stays silent when PreCompact already reset the counter', () => {
    primeCounter('s1');
    runHook('pre-compact', { session_id: 's1', transcript_path: transcript }, { cwd });

    const run = runHook('stop', { session_id: 's1', transcript_path: transcript }, { cwd });

    expect(run.stdout).toBe('{}');
    expect(readSessionState('s1').stop_count).toBe(1);
  });
});
