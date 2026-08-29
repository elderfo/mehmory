/** `finalizeSession` core-op tests (issue #16): the SessionEnd hook adapter is now
 * just a caller of this. */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTempDir } from './helpers.js';
import { writeCodexRollout, writeTranscript } from './hook-fixture.js';
import { finalizePendingSessions, finalizeSession, scopePaths } from '../src/core/capture.js';
import { loadConfig, type MehmoryConfig } from '../src/core/config.js';
import { mehmoryHome, statePath } from '../src/core/home.js';
import { resolveProjectKey } from '../src/core/identity.js';
import * as sessionModule from '../src/core/session.js';
import { freshSessionState, sessionStatePath, writeSessionState } from '../src/core/session.js';
import { initStore } from '../src/core/store.js';

/** Every file under the store, keyed by its path relative to `mehmoryHome()`, content
 * included — excludes `.git` (its own internals are covered separately via `git log`). */
function snapshotStore(): Record<string, string> {
  const home = mehmoryHome();
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files[relative(home, full)] = readFileSync(full, 'utf-8');
      }
    }
  };
  walk(home);
  return files;
}

function gitLog(): string {
  return execFileSync('git', ['-C', mehmoryHome(), 'log', '--oneline'], { encoding: 'utf-8' });
}

describe('finalizeSession', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = resolveProjectKey(cwd);
    initStore();
  });

  it('distills, queues, logs, commits, and drops session state', () => {
    const transcript = writeTranscript([{ text: 'We decided to ship the plugin unbundled.' }]);

    const result = finalizeSession('s1', transcript, key, 'claude-code');

    expect(result.capturedEntries).toBe(1);
    expect(existsSync(sessionStatePath('s1'))).toBe(false);
    const queued = readdirSync(statePath('queue')).filter(f => f.endsWith('.json'));
    expect(queued).toHaveLength(1);
    expect(gitLog()).toContain('session s1 ended');
  });

  it('is a no-op on a second call for the same session (issue #16)', () => {
    const transcript = writeTranscript([{ text: 'We decided to ship the plugin unbundled.' }]);

    const first = finalizeSession('s1', transcript, key, 'claude-code');
    const afterFirst = snapshotStore();
    const logAfterFirst = gitLog();

    const second = finalizeSession('s1', transcript, key, 'claude-code');
    const afterSecond = snapshotStore();
    const logAfterSecond = gitLog();

    expect(first.capturedEntries).toBe(1);
    expect(second.capturedEntries).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
    expect(logAfterSecond).toBe(logAfterFirst);
  });

  it('is a no-op when there is nothing to distill (empty transcript)', () => {
    const transcript = writeTranscript([]);

    finalizeSession('s2', transcript, key, 'claude-code');
    const afterFirst = snapshotStore();

    finalizeSession('s2', transcript, key, 'claude-code');
    const afterSecond = snapshotStore();

    expect(afterSecond).toEqual(afterFirst);
  });

  it('does not double-log or double-commit when the completion marker write fails after the rest of the work already landed (seam defect)', () => {
    const transcript = writeTranscript([{ text: 'We decided to ship the plugin unbundled.' }]);
    const sessionId = 's3';

    // Simulate `markSessionFinalized`'s write failing on the first call, after
    // distill/enqueue/log/commit have already run — exactly the partial-failure
    // window the seam finding describes (deleteSessionState already ran too, in the
    // pre-fix ordering; that ordering is no longer what protects against the retry).
    const markSpy = vi.spyOn(sessionModule, 'markSessionFinalized').mockImplementationOnce(() => {
      throw new Error('simulated marker write failure');
    });

    expect(() => finalizeSession(sessionId, transcript, key, 'claude-code')).toThrow('simulated marker write failure');

    // The failure was transient (as most write failures are); it clears and the
    // SessionEnd hook is retried, the same way a harness would retry.
    markSpy.mockRestore();
    const retried = finalizeSession(sessionId, transcript, key, 'claude-code');

    const logLines = readFileSync(scopePaths(key).logFile, 'utf-8')
      .split('\n')
      .filter(line => line.includes(`(session ${sessionId})`));
    const commits = gitLog()
      .split('\n')
      .filter(line => line.includes(`session ${sessionId} ended`));

    expect(logLines).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(retried.capturedEntries).toBe(0);
  });

  it('still captures the tail when hooks.session_end is disabled — a toggle must never destroy un-captured material (F3-1)', () => {
    const transcript = writeCodexRollout([{ text: 'We decided to ship the plugin unbundled.' }]);
    const base = loadConfig();
    const config: MehmoryConfig = {
      ...base,
      hooks: { ...base.hooks, session_end: { enabled: false } },
    };

    const result = finalizeSession('s4', transcript, key, 'codex', config);

    expect(result.capturedEntries).toBe(1);
    const queued = readdirSync(statePath('queue')).filter(f => f.endsWith('.json'));
    expect(queued).toHaveLength(1);
  });
});

describe('finalizePendingSessions', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = resolveProjectKey(cwd);
    initStore();
  });

  // Restoring inline at the end of each test loses the spy when an assertion throws, and
  // a leaked `listPendingSessions` stub turns one real failure into a cascade in the next
  // describe. vitest.config.ts sets no `restoreMocks`, so the cleanup has to be here.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('one bad session does not abandon the rest of the sweep (F3-10)', () => {
    const transcript = writeTranscript([{ text: 'We decided to ship the plugin unbundled.' }]);
    const pending = ['bad', 'good'].map(id => ({
      ...freshSessionState(id),
      transcript_path: transcript,
      project_key: key,
      host: 'claude-code' as const,
    }));

    vi.spyOn(sessionModule, 'listPendingSessions').mockReturnValue(pending);
    vi.spyOn(sessionModule, 'markSessionFinalized').mockImplementation((id: string) => {
      if (id === 'bad') throw new Error('simulated marker write failure');
    });

    // 1, not 0: the good session completed and must be counted, and it must be reached
    // at all — the pre-fix single failOpen around the whole loop aborted on the first
    // throw and reported nothing finalized.
    expect(finalizePendingSessions('current', key, 'claude-code')).toBe(1);

    const log = readFileSync(scopePaths(key).logFile, 'utf-8');
    expect(log).toContain('(session good)');
  });

  // Regression: an abandoned session must finalize into the project it actually ran in,
  // not into whichever project the next session happened to start in. The fallback in
  // `finalizePendingSessions` (`state.project_key ?? project`) is only correct if the
  // origin write records the key -- nothing did, so every deferred finalize filed one
  // project's transcript under another's scope.
  //
  // Note this test deliberately does NOT hand-write `project_key` into the fixture: it
  // goes through `rememberSessionOrigin`, the same call the hook makes. Constructing the
  // state by hand is what hid the bug from the sweep test above.
  it('finalizes an abandoned session into its own project, not the sweeping one', () => {
    const otherCwd = createTempDir('mehmory-other-project');
    const otherKey = resolveProjectKey(otherCwd);
    expect(otherKey).not.toBe(key);

    const transcript = writeTranscript([{ text: 'We decided to pin the runtime to Node 22.' }]);

    // The abandoned session's own hook invocation, recording where it ran.
    sessionModule.rememberSessionOrigin('orphan', transcript, 'claude-code', otherKey);

    vi.spyOn(sessionModule, 'listPendingSessions').mockReturnValue([
      sessionModule.readSessionState('orphan'),
    ]);

    // A session in `key` sweeps it up.
    expect(finalizePendingSessions('current', key, 'claude-code')).toBe(1);

    expect(readFileSync(scopePaths(otherKey).logFile, 'utf-8')).toContain('(session orphan)');
    expect(existsSync(scopePaths(key).logFile)).toBe(false);
  });

  // The `state.project_key ?? project` fallback still has a live job after this change:
  // every session state written before it carries no key. Those sessions finalize into the
  // sweeping project on their one post-upgrade sweep, which is wrong but bounded -- the
  // alternative is dropping them. Pinned so the fallback is not "cleaned up" later.
  it('falls back to the sweeping project for pre-upgrade state that has no project_key', () => {
    const transcript = writeTranscript([{ text: 'We decided to pin the runtime to Node 22.' }]);
    const legacy = {
      ...freshSessionState('legacy'),
      transcript_path: transcript,
      host: 'claude-code' as const,
    };
    expect(legacy.project_key).toBeUndefined();

    vi.spyOn(sessionModule, 'listPendingSessions').mockReturnValue([legacy]);

    expect(finalizePendingSessions('current', key, 'claude-code')).toBe(1);
    expect(readFileSync(scopePaths(key).logFile, 'utf-8')).toContain('(session legacy)');
  });
});

describe('finalizeSession — deferred capture for not-yet-flushed transcripts', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-defer');
    key = resolveProjectKey(cwd);
    initStore();
  });

  it('defers instead of retiring when a named transcript is not yet on disk', () => {
    // The Claude Agent SDK (ACP) writes its rollout AFTER SessionEnd fires, so a named-but-
    // absent transcript here is a not-yet-flushed session, not an empty one. Finalizing would
    // capture nothing and lose the content once the file lands.
    const absent = join(createTempDir('mehmory-notyet'), 'rollout.jsonl');
    writeSessionState({ ...freshSessionState('s1'), transcript_path: absent });

    const result = finalizeSession('s1', absent, key, 'claude-code', loadConfig(), {
      deferWhenTranscriptAbsent: true,
    });

    expect(result.deferred).toBe(true);
    expect(result.capturedEntries).toBe(0);
    // Left pending: state kept, no finalized marker, so the next start's sweep retries.
    expect(existsSync(sessionStatePath('s1'))).toBe(true);
    expect(sessionModule.isSessionFinalized('s1')).toBe(false);
  });

  it('captures normally once the transcript exists, even with the defer flag set', () => {
    const transcript = writeTranscript([
      { text: 'We deferred capture until the rollout flushed.' },
    ]);

    const result = finalizeSession('s2', transcript, key, 'claude-code', loadConfig(), {
      deferWhenTranscriptAbsent: true,
    });

    expect(result.deferred).toBeFalsy();
    expect(result.capturedEntries).toBe(1);
    expect(existsSync(sessionStatePath('s2'))).toBe(false);
    expect(sessionModule.isSessionFinalized('s2')).toBe(true);
  });

  it('recovers a deferred session once its transcript lands (the sweep captures it)', () => {
    // The scenario the whole fix exists for: SessionEnd defers because the rollout is not on
    // disk yet, then the Agent SDK flushes it, then a later start's sweep captures it. This
    // exercises the cross-module coupling the defer branch depends on — the transcript path
    // persisted in state and read back by the sweep.
    const absent = join(createTempDir('mehmory-late'), 'rollout.jsonl');
    const pendingState = {
      ...freshSessionState('s4'),
      transcript_path: absent,
      project_key: key,
      host: 'claude-code' as const,
    };
    writeSessionState(pendingState);

    // SessionEnd fires before the rollout is flushed -> defers, stays pending.
    const deferred = finalizeSession('s4', absent, key, 'claude-code', loadConfig(), {
      deferWhenTranscriptAbsent: true,
    });
    expect(deferred.deferred).toBe(true);
    expect(sessionModule.isSessionFinalized('s4')).toBe(false);

    // The Agent SDK now flushes the rollout to the recorded path.
    writeFileSync(
      absent,
      `${JSON.stringify({
        type: 'message',
        role: 'user',
        sessionId: 's4',
        uuid: 'u1',
        text: 'We decided to ship the plugin unbundled.',
      })}\n`
    );

    // The next start's sweep passes no options, so it force-finalizes — and because the
    // transcript now exists, it captures the content instead of losing it.
    vi.spyOn(sessionModule, 'listPendingSessions').mockReturnValue([pendingState]);
    const finalized = finalizePendingSessions('current', key, 'claude-code');
    vi.restoreAllMocks();

    expect(finalized).toBe(1);
    expect(sessionModule.isSessionFinalized('s4')).toBe(true);
    const queued = readdirSync(statePath('queue')).filter(f => f.endsWith('.json'));
    expect(queued).toHaveLength(1);
  });

  it('does not defer a session whose persisted state lacks a transcript_path (avoids a strand)', () => {
    // Guard for the case the review flagged: if the on-disk state has no transcript_path,
    // listPendingSessions skips it forever, so deferring would strand it in perpetual pending.
    // Retire it now instead (the pre-fix outcome) rather than lose it to a sweep that never runs.
    const absent = join(createTempDir('mehmory-strand'), 'rollout.jsonl');
    writeSessionState(freshSessionState('s5')); // fresh state carries no transcript_path

    const result = finalizeSession('s5', absent, key, 'claude-code', loadConfig(), {
      deferWhenTranscriptAbsent: true,
    });

    expect(result.deferred).toBeFalsy();
    expect(existsSync(sessionStatePath('s5'))).toBe(false); // retired, not stranded
    expect(sessionModule.isSessionFinalized('s5')).toBe(true);
  });

  it('force-finalizes an absent transcript when not asked to defer (abandonment path)', () => {
    // The pending sweep passes no options, so after its idle window a session whose transcript
    // never landed still retires rather than retrying forever.
    const absent = join(createTempDir('mehmory-never'), 'rollout.jsonl');
    writeSessionState({ ...freshSessionState('s3'), transcript_path: absent });

    const result = finalizeSession('s3', absent, key, 'claude-code');

    expect(result.deferred).toBeFalsy();
    expect(existsSync(sessionStatePath('s3'))).toBe(false);
    expect(sessionModule.isSessionFinalized('s3')).toBe(true);
  });
});
