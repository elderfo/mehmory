/** Stop fixture tests (criteria 11, 14, 16, 19). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTempDir } from './helpers.js';
import {
  additionalContext,
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

    expect(run.status).toBe(0);
    const reason = additionalContext(run);
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

  it('blocks Claude Code without claiming the hook errored', () => {
    primeCounter('s1');

    const run = runHook(
      'stop',
      { session_id: 's1', transcript_path: transcript },
      { cwd, args: ['claude-code'] }
    );
    const output = outputJson(run);

    // `additionalContext` blocks exactly as `decision: block` does — same
    // `blockingErrors` array, same `stop_hook_active` on the next Stop — but renders as
    // `Stop hook feedback:` instead of `Stop hook error:` and raises no error toast.
    expect(output['decision']).toBeUndefined();
    expect(output['hookSpecificOutput']).toMatchObject({ hookEventName: 'Stop' });
    expect(additionalContext(run)).toContain('mehmory:');
  });

  it('keeps the reason short enough to read in the transcript', () => {
    primeCounter('s1');
    const reason = additionalContext(
      runHook(
        'stop',
        { session_id: 's1', transcript_path: transcript },
        { cwd, args: ['claude-code'] }
      )
    );

    // Every host prints this verbatim into the session log. The executable `inbox-tx`
    // fallback is Codex-only (the skill is not a slash command there); on Claude Code
    // the skill ships with the hook, so the command is dead weight on screen.
    expect(reason).not.toContain('inbox-tx.mjs append');
    expect(reason.length).toBeLessThan(320);
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
