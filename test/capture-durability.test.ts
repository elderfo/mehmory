import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { captureDelta, finalizePendingSessions, finalizeSession } from '../src/core/capture.js';
import { statePath } from '../src/core/home.js';
import { readInboxEntries } from '../src/core/inbox.js';
import { claimJob } from '../src/core/queue.js';
import * as fsModule from '../src/core/fs.js';
import {
  advanceSessionCursorUnlocked,
  incrementStopCount,
  readSessionState,
  rememberTopic,
  resetStopCount,
  sessionStatePath,
  setPaused,
} from '../src/core/session.js';
import { withSessionLock } from '../src/core/lock.js';
import { createTempDir } from './helpers.js';
import { keyFor, paths, runHook, seedStore, writeTranscript } from './hook-fixture.js';

describe('capture durability', () => {
  let cwd: string;
  let key: string;
  let transcript: string;

  beforeEach(() => {
    cwd = createTempDir('capture-project');
    key = keyFor(cwd);
    seedStore(key);
    transcript = writeTranscript(
      [{ text: 'We decided to keep durable capture retries.' }],
      'durable'
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('retries the same delta after a busy store prevents its append', () => {
    mkdirSync(statePath('locks'), { recursive: true });
    const lock = statePath('locks', '__store__.lock');
    writeFileSync(lock, String(process.pid));
    expect(captureDelta('durable', transcript, key, 'claude-code').appended).toBe(0);
    expect(readSessionState('durable').cursor.offset).toBe(0);
    rmSync(lock);
    expect(captureDelta('durable', transcript, key, 'claude-code').appended).toBe(1);
    expect(readInboxEntries(paths(key).inbox).map((e) => e.text)).toEqual([
      'We decided to keep durable capture retries.',
    ]);
  });

  it('replays a partially appended delta without losing or duplicating entries', () => {
    transcript = writeTranscript(
      [
        { text: 'We decided to keep durable capture retries.' },
        { text: 'We decided to deduplicate partial capture retries.' },
      ],
      'durable'
    );
    const append = fsModule.appendRecord;
    vi.spyOn(fsModule, 'appendRecord')
      .mockImplementationOnce(append)
      .mockReturnValueOnce({ ok: false, error: 'disk write failed' });
    expect(captureDelta('durable', transcript, key, 'claude-code').failed).toBe(1);
    expect(readSessionState('durable').cursor.offset).toBe(0);
    vi.restoreAllMocks();
    expect(captureDelta('durable', transcript, key, 'claude-code').appended).toBe(1);
    expect(readInboxEntries(paths(key).inbox).map((e) => e.text)).toEqual([
      'We decided to keep durable capture retries.',
      'We decided to deduplicate partial capture retries.',
    ]);
  });

  it('fails open and replays safely if the cursor write fails after an append', () => {
    const write = fsModule.atomicWrite;
    vi.spyOn(fsModule, 'atomicWrite').mockImplementation((path, content) => {
      if (path === sessionStatePath('durable')) throw new Error('cursor write failed');
      write(path, content);
    });
    expect(captureDelta('durable', transcript, key, 'claude-code').failed).toBe(1);
    expect(readSessionState('durable').cursor.offset).toBe(0);
    vi.restoreAllMocks();
    expect(captureDelta('durable', transcript, key, 'claude-code').appended).toBe(0);
    expect(readInboxEntries(paths(key).inbox).length).toBe(1);
    expect(readSessionState('durable').cursor.offset).toBeGreaterThan(0);
  });

  it('retries the same tail after enqueue fails', () => {
    const original = fsModule.atomicWrite;
    vi.spyOn(fsModule, 'atomicWrite').mockImplementation((path, content) => {
      if (path.startsWith(statePath('queue') + '/')) throw new Error('queue write failed');
      original(path, content);
    });
    expect(finalizeSession('durable', transcript, key, 'claude-code')).toEqual({
      capturedEntries: 0,
      deferred: true,
    });
    expect(readSessionState('durable').cursor.offset).toBe(0);
    vi.restoreAllMocks();
    expect(finalizeSession('durable', transcript, key, 'claude-code').capturedEntries).toBe(1);
    expect(
      (claimJob('distill-final')?.data['entries'] as { text: string }[]).map((e) => e.text)
    ).toEqual(['We decided to keep durable capture retries.']);
  });

  it('ordinary mutators and trailing capture never resurrect finalized state', () => {
    finalizeSession('durable', transcript, key, 'claude-code');
    incrementStopCount('durable');
    resetStopCount('durable');
    rememberTopic('durable', new Set(['capture']));
    setPaused('durable', true);
    withSessionLock('durable', () =>
      advanceSessionCursorUnlocked('durable', transcript, 'last', 1)
    );
    captureDelta('durable', transcript, key, 'claude-code');
    expect(existsSync(sessionStatePath('durable'))).toBe(false);
    expect(readInboxEntries(paths(key).inbox)).toEqual([]);
  });

  it('SessionStart explicitly resumes from the saved cursor and records the returning agent', () => {
    finalizeSession('durable', transcript, key, 'claude-code');
    expect(
      runHook(
        'session-start',
        { session_id: 'durable', transcript_path: transcript },
        {
          cwd,
          env: { MEHMORY_AGENT: 'returning' },
        }
      ).status
    ).toBe(0);
    expect(readSessionState('durable').generation).toBe(1);
    expect(readSessionState('durable').agent).toBe('returning');
    transcript = writeTranscript(
      [
        { text: 'We decided to keep durable capture retries.' },
        { text: 'We decided to capture only the resumed tail.' },
      ],
      'durable'
    );
    expect(
      captureDelta('durable', transcript, key, 'claude-code').entries.map((e) => e.text)
    ).toEqual(['We decided to capture only the resumed tail.']);
  });

  it.each(['scout', ''])('sweeps with the origin agent %j, not the sweeping agent', (agent) => {
    expect(
      runHook(
        'stop',
        { session_id: 'durable', transcript_path: transcript },
        {
          cwd,
          env: { MEHMORY_AGENT: agent },
        }
      ).status
    ).toBe(0);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(sessionStatePath('durable'), old, old);
    utimesSync(transcript, old, old);
    vi.stubEnv('MEHMORY_AGENT', 'sweeper');
    try {
      expect(finalizePendingSessions('current', key, 'claude-code')).toBe(1);
      const entries = claimJob('distill-final')?.data['entries'] as { agent?: string }[];
      expect(entries.map((e) => e.agent ?? null)).toEqual([agent || null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
