/**
 * Finalization at the next session start (issue #24), through the built bundles.
 *
 * Codex has no session-end event, so the last stretch of a Codex session has exactly one
 * route into the inbox: the next session that starts finds the abandoned state and
 * finalizes it. A Claude Code session killed before SessionEnd fires is the same shape.
 * Every payload here is the measured Codex shape (`.research/codex-spike/VERDICT.md`):
 * `transcript_path` on every event, `argv[2] === 'codex'` with the installer's trailing
 * `--mehmory` ownership marker.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, utimesSync } from 'node:fs';
import { createTempDir } from './helpers.js';
import {
  errorsLog,
  keyFor,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeCodexRollout,
  writeTranscript,
} from './hook-fixture.js';
import { mehmoryHome } from '../src/core/home.js';
import { readSessionState, sessionStatePath } from '../src/core/session.js';
import { parseInboxEntries } from '../src/schema/format.js';

/** The arguments `mehmory init --codex` writes: host first, ownership marker after. */
const CODEX_ARGS = ['codex', '--mehmory'] as const;

/** A real rollout uuid from the captured payloads — Codex reports it as `session_id`. */
const ABANDONED = '019fbf44-4f17-7a53-8914-1002bc65fbae';

const ROLLOUT = [{ text: 'We decided to use fly.io for deploys.' }];

/**
 * Age a session's state past `PENDING_FINALIZE_IDLE_MS` so it reads as abandoned rather
 * than as a session running concurrently in another terminal.
 */
function abandon(sessionId: string, transcriptPath?: string): void {
  const path = sessionStatePath(sessionId);
  expect(existsSync(path), `${sessionId} left no state to abandon`).toBe(true);
  const long_ago = new Date(Date.now() - 6 * 60 * 60 * 1000);
  utimesSync(path, long_ago, long_ago);
  // The transcript has to go quiet as well, because that is what abandonment is: nothing
  // is appending to it any more. Ageing only the state file described a session that had
  // stopped firing hooks while its transcript kept growing -- which is a session in the
  // middle of a long turn, the one case the sweep must NOT touch.
  if (transcriptPath !== undefined && existsSync(transcriptPath)) {
    utimesSync(transcriptPath, long_ago, long_ago);
  }
}

/** `mehmory: session <id> ended` commits in the store's history. */
function endCommits(sessionId: string): number {
  const log = execFileSync('git', ['-C', mehmoryHome(), 'log', '--oneline'], {
    encoding: 'utf-8',
  });
  return log.split('\n').filter(line => line.includes(`session ${sessionId} ended`)).length;
}

/** `session-end` lines in a scope's log.md. */
function endLogLines(key: string): number {
  return readIfPresent(paths(key).log)
    .split('\n')
    .filter(line => line.includes('session-end')).length;
}

describe('finalization at the next session start (#24)', () => {
  let cwd: string;
  let key: string;
  let rollout: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
    rollout = writeCodexRollout(ROLLOUT, ABANDONED);
  });

  /** A Codex session that stopped below the capture threshold and never came back. */
  function abruptCodexSession(): void {
    runHook(
      'stop',
      { session_id: ABANDONED, transcript_path: rollout, cwd, hook_event_name: 'Stop' },
      { cwd, args: CODEX_ARGS }
    );
    expect(readIfPresent(paths(key).inbox)).toBe('');
    abandon(ABANDONED, rollout);
  }

  it('recovers an abruptly ended Codex session, exactly once', () => {
    abruptCodexSession();

    runHook(
      'session-start',
      { session_id: 'next-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );

    // The material the dead session never got to file is in the inbox, parsed by the
    // Codex reader and attributed to Codex — not to the harness that happened to start.
    const entries = parseInboxEntries(readIfPresent(paths(key).inbox));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.host === 'codex')).toBe(true);
    expect(entries.every(entry => entry.src === ABANDONED)).toBe(true);
    expect(entries.some(entry => entry.text.includes('fly.io'))).toBe(true);

    // Exactly once: one log line, one commit, and the dead session's state is gone.
    expect(endLogLines(key)).toBe(1);
    expect(endCommits(ABANDONED)).toBe(1);
    expect(existsSync(sessionStatePath(ABANDONED))).toBe(false);
    expect(statsLines().at(-1)).toMatchObject({
      hook: 'SessionStart',
      finalized_sessions: 1,
    });
  });

  // The bug this guards: a marker meant "this id is done forever", so a harness that
  // reuses a session id on resume could never finalize again and the whole resumed run
  // was lost. Driven through the built bundles on purpose -- the wiring that clears the
  // marker lives in the SessionStart hook, and a unit test of the core op would not see
  // it. Observed in a real store as a marker five days older than the same id's state.
  it('finalizes a resumed session whose id was already marked finalized', () => {
    abruptCodexSession();

    // Someone else's start retires it, exactly as before.
    runHook(
      'session-start',
      { session_id: 'next-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );
    expect(endLogLines(key)).toBe(1);
    expect(existsSync(sessionStatePath(ABANDONED))).toBe(false);

    // Now that id comes back: the harness resumed the conversation.
    runHook(
      'session-start',
      { session_id: ABANDONED, transcript_path: rollout, cwd, source: 'resume' },
      { cwd, args: CODEX_ARGS }
    );

    // It records new material and stops, the way any live session does.
    runHook(
      'stop',
      { session_id: ABANDONED, transcript_path: rollout, cwd, hook_event_name: 'Stop' },
      { cwd, args: CODEX_ARGS }
    );
    expect(existsSync(sessionStatePath(ABANDONED))).toBe(true);
    abandon(ABANDONED, rollout);

    // A later start must be able to retire it a second time. Before the fix the stale
    // marker made this a permanent no-op.
    runHook(
      'session-start',
      { session_id: 'third-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );

    expect(endLogLines(key)).toBe(2);
    expect(existsSync(sessionStatePath(ABANDONED))).toBe(false);
  });

  // The bug: idle detection read the state file's mtime, which only moves when a hook
  // writes. A session inside one long turn -- a slow build, a long tool call -- fires no
  // hooks, looked abandoned after the window, and was finalized while alive: state
  // deleted, id marked done, everything it recorded afterwards silently dropped. Driven
  // through the built bundles because the sweep runs inside the SessionStart hook.
  it('does not finalize a session that is mid-turn with a growing transcript', () => {
    runHook(
      'stop',
      { session_id: ABANDONED, transcript_path: rollout, cwd, hook_event_name: 'Stop' },
      { cwd, args: CODEX_ARGS }
    );

    // No hook has touched state for six hours. The transcript is still being written.
    const long_ago = new Date(Date.now() - 6 * 60 * 60 * 1000);
    utimesSync(sessionStatePath(ABANDONED), long_ago, long_ago);

    runHook(
      'session-start',
      { session_id: 'other-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );

    // Untouched: still pending, nothing logged, nothing retired.
    expect(existsSync(sessionStatePath(ABANDONED))).toBe(true);
    expect(endLogLines(key)).toBe(0);
    expect(readIfPresent(paths(key).inbox)).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ finalized_sessions: 0 });

    // Once it does go quiet, the next start retires it as before.
    abandon(ABANDONED, rollout);
    runHook(
      'session-start',
      { session_id: 'later-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );
    expect(endLogLines(key)).toBe(1);
    expect(existsSync(sessionStatePath(ABANDONED))).toBe(false);
  });

  it('does not double-write or double-commit when a later session start runs again', () => {
    abruptCodexSession();
    runHook(
      'session-start',
      { session_id: 'next-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );
    const afterFirst = readIfPresent(paths(key).inbox);
    expect(afterFirst).not.toBe('');

    runHook(
      'session-start',
      { session_id: 'third-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );

    expect(readIfPresent(paths(key).inbox)).toBe(afterFirst);
    expect(endLogLines(key)).toBe(1);
    expect(endCommits(ABANDONED)).toBe(1);
    expect(statsLines().at(-1)).toMatchObject({ finalized_sessions: 0 });
  });

  it('leaves a session its own SessionEnd already finalized alone', () => {
    const transcript = writeTranscript([{ text: 'We decided to pin node to 22.' }], 'claude-a');
    runHook(
      'session-end',
      { session_id: 'claude-a', transcript_path: transcript },
      { cwd, args: ['claude-code'] }
    );
    // SessionEnd deletes its own state, so re-plant an aged one: the marker, not the
    // absence of state, is what must make the second pass a no-op.
    runHook(
      'stop',
      { session_id: 'claude-a', transcript_path: transcript },
      { cwd, args: ['claude-code'] }
    );
    abandon('claude-a');

    runHook(
      'session-start',
      { session_id: 'next-session', source: 'startup' },
      { cwd, args: ['claude-code'] }
    );

    expect(endLogLines(key)).toBe(1);
    expect(endCommits('claude-a')).toBe(1);
    expect(statsLines().at(-1)).toMatchObject({ finalized_sessions: 0 });
  });

  it('does not retire a session that is merely running elsewhere', () => {
    // Same setup, minus the ageing: a live session touches its state constantly, so a
    // fresh state file is a session in progress, not an abandoned one.
    runHook(
      'stop',
      { session_id: ABANDONED, transcript_path: rollout, cwd },
      { cwd, args: CODEX_ARGS }
    );

    runHook(
      'session-start',
      { session_id: 'next-session', transcript_path: rollout, cwd, source: 'startup' },
      { cwd, args: CODEX_ARGS }
    );

    expect(existsSync(sessionStatePath(ABANDONED))).toBe(true);
    expect(readSessionState(ABANDONED).stop_count).toBe(1);
    expect(readIfPresent(paths(key).inbox)).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ finalized_sessions: 0 });
  });

  it('records the transcript, host and project a leftover session must be read with', () => {
    runHook(
      'stop',
      { session_id: ABANDONED, transcript_path: rollout, cwd },
      { cwd, args: CODEX_ARGS }
    );

    // `project_key` is asserted here, against a real hook subprocess, and not only in the
    // unit tests: `runHook` is the sole production caller that supplies it, so passing the
    // raw cwd or a stale key there would type-check and silently restore the misfiling this
    // whole change exists to fix.
    expect(readSessionState(ABANDONED)).toMatchObject({
      transcript_path: rollout,
      host: 'codex',
      project_key: key,
    });
  });
});

describe('PreCompact payload guard (#24)', () => {
  let cwd: string;
  let key: string;
  let rollout: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
    rollout = writeCodexRollout(ROLLOUT, ABANDONED);
  });

  it('captures through the shared core when the payload carries a readable transcript', () => {
    const run = runHook(
      'pre-compact',
      { session_id: ABANDONED, transcript_path: rollout, cwd, hook_event_name: 'PreCompact' },
      { cwd, args: CODEX_ARGS }
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const entries = parseInboxEntries(readIfPresent(paths(key).inbox));
    expect(entries.some(entry => entry.text.includes('fly.io'))).toBe(true);
    expect(entries.every(entry => entry.host === 'codex')).toBe(true);
  });

  // Codex's PreCompact payload is unverified: the event exists in Codex CLI 0.146.0 but
  // no spike run ever fired it. An unrecognized shape must degrade to doing nothing, not
  // to an error in the user's session (A2, A8).
  for (const [name, payload] of [
    ['no transcript_path at all', { session_id: ABANDONED }],
    ['a transcript_path that is not a string', { session_id: ABANDONED, transcript_path: 42 }],
    ['an empty transcript_path', { session_id: ABANDONED, transcript_path: '' }],
    [
      'a transcript_path pointing nowhere',
      { session_id: ABANDONED, transcript_path: '/nonexistent/rollout.jsonl' },
    ],
    ['a payload of foreign fields only', { session_id: ABANDONED, compact_reason: 'auto' }],
  ] as const) {
    it(`fails open on ${name}`, () => {
      const run = runHook('pre-compact', { ...payload, cwd }, { cwd, args: CODEX_ARGS });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe('');
      expect(readIfPresent(paths(key).inbox)).toBe('');
      // Silent to the session, visible in the store: the guard logs what it refused.
      expect(errorsLog()).toContain('E_TRANSCRIPT_PARSE');
      // And it does not touch the session: a cursor reset on an unreadable payload
      // would be the guard causing the loss it exists to prevent.
      expect(readSessionState(ABANDONED).cursor.offset).toBe(0);
      expect(statsLines().at(-1)).toMatchObject({ hook: 'PreCompact' });
    });
  }
});
