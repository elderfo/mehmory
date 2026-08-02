/** `finalizeSession` core-op tests (issue #16): the SessionEnd hook adapter is now
 * just a caller of this. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTempDir } from './helpers.js';
import { writeCodexRollout, writeTranscript } from './hook-fixture.js';
import { finalizePendingSessions, finalizeSession, scopePaths } from '../src/core/capture.js';
import { loadConfig, type MehmoryConfig } from '../src/core/config.js';
import { mehmoryHome, statePath } from '../src/core/home.js';
import { resolveProjectKey } from '../src/core/identity.js';
import * as sessionModule from '../src/core/session.js';
import { freshSessionState, sessionStatePath } from '../src/core/session.js';
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
    vi.restoreAllMocks();
  });
});
