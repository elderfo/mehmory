import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { captureDelta, finalizePendingSessions, finalizeSession } from '../src/core/capture.js';
import { statePath } from '../src/core/home.js';
import { readInboxEntries } from '../src/core/inbox.js';
import { claimJob } from '../src/core/queue.js';
import * as fsModule from '../src/core/fs.js';
import {
  advanceSessionCursorUnlocked,
  finalizedMarkerPath,
  incrementStopCount,
  readSessionState,
  rememberTopic,
  resetStopCount,
  sessionStatePath,
  setPaused,
} from '../src/core/session.js';
import { withSessionLock } from '../src/core/lock.js';
import { createTempDir } from './helpers.js';
import {
  keyFor,
  paths,
  runHook,
  seedStore,
  writeCodexRollout,
  writePiSession,
  writeTranscript,
} from './hook-fixture.js';

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

  it('keeps a swept live session paused when its transcript grows', () => {
    writeFileSync(
      statePath('..', 'config.json'),
      JSON.stringify({ stop: { capture_threshold: 2 } })
    );
    const input = { session_id: 'durable', transcript_path: transcript };
    runHook('stop', input, { cwd });
    setPaused('durable', true);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(sessionStatePath('durable'), old, old);
    utimesSync(transcript, old, old);
    runHook('session-start', { session_id: 'sweeper' }, { cwd });
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'message',
        role: 'user',
        sessionId: 'durable',
        uuid: 'paused-tail',
        text: 'We decided this stretch must remain paused.',
      }) + '\n'
    );
    runHook('stop', input, { cwd });
    runHook('stop', input, { cwd });
    expect(readSessionState('durable').paused).toBe(true);
    expect(readInboxEntries(paths(key).inbox)).toEqual([]);
  });

  it('unchanged incomplete transcript tails do not resurrect finalized state', () => {
    appendFileSync(transcript, '{"type":"message"');
    finalizeSession('durable', transcript, key, 'claude-code');
    const marker = fsModule.readFile(finalizedMarkerPath('durable'));
    incrementStopCount('durable');
    captureDelta('durable', transcript, key, 'claude-code');
    finalizeSession('durable', transcript, key, 'claude-code');
    expect(existsSync(sessionStatePath('durable'))).toBe(false);
    expect(fsModule.readFile(finalizedMarkerPath('durable'))).toBe(marker);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)(
    '%s captures a swept live session after later Stops without replaying its old entries',
    (host) => {
      const writer = {
        'claude-code': writeTranscript,
        codex: writeCodexRollout,
        pi: writePiSession,
      }[host];
      transcript = writer([{ text: 'We decided to keep durable capture retries.' }], 'durable');
      const options = { cwd, args: [host] };
      writeFileSync(
        statePath('..', 'config.json'),
        JSON.stringify({ stop: { capture_threshold: 2 } })
      );
      const input = { session_id: 'durable', transcript_path: transcript };
      runHook('stop', input, options);
      runHook('stop', input, options);
      expect(readInboxEntries(paths(key).inbox).map((e) => e.text)).toEqual([
        'We decided to keep durable capture retries.',
      ]);
      writeFileSync(paths(key).inbox, '# Inbox\n');
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(sessionStatePath('durable'), old, old);
      utimesSync(transcript, old, old);
      runHook('session-start', { session_id: 'sweeper' }, options);
      expect(existsSync(sessionStatePath('durable'))).toBe(false);
      const text = 'We decided to capture work after the idle sweep.';
      const record = {
        'claude-code': {
          type: 'message',
          role: 'user',
          sessionId: 'durable',
          uuid: 'new-tail',
          text,
        },
        codex: { type: 'event_msg', payload: { type: 'user_message', message: text } },
        pi: {
          type: 'message',
          id: 'new-tail',
          message: { role: 'user', content: [{ type: 'text', text }] },
        },
      }[host];
      appendFileSync(transcript, JSON.stringify(record) + '\n');
      utimesSync(transcript, old, old);
      for (let i = 0; i < 4; i++) runHook('stop', input, options);
      expect(readInboxEntries(paths(key).inbox).map((e) => e.text)).toEqual([
        'We decided to capture work after the idle sweep.',
      ]);
      expect(readSessionState('durable').generation).toBe(1);
    }
  );

  it.each(['pre-compact', 'session-end'] as const)(
    '%s resumes a swept session without SessionStart',
    (hook) => {
      runHook('stop', { session_id: 'durable', transcript_path: transcript }, { cwd });
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(sessionStatePath('durable'), old, old);
      utimesSync(transcript, old, old);
      expect(finalizePendingSessions('sweeper', key, 'claude-code')).toBe(1);
      claimJob('distill-final');
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'message',
          role: 'user',
          sessionId: 'durable',
          uuid: 'new-tail',
          text: 'We decided to capture work after the idle sweep.',
        }) + '\n'
      );
      runHook(hook, { session_id: 'durable', transcript_path: transcript }, { cwd });
      const entries =
        hook === 'pre-compact'
          ? readInboxEntries(paths(key).inbox)
          : (claimJob('distill-final')?.data['entries'] as { text: string }[]);
      expect(entries.map((e) => e.text)).toEqual([
        'We decided to capture work after the idle sweep.',
      ]);
    }
  );

  it('ordinary mutations resume from a saved transcript modified after finalization', () => {
    runHook('stop', { session_id: 'durable', transcript_path: transcript }, { cwd });
    finalizeSession('durable', transcript, key, 'claude-code');
    const later = new Date(Date.now() + 1000);
    utimesSync(transcript, later, later);
    expect(incrementStopCount('durable')).toBe(1);
    expect(readSessionState('durable').generation).toBe(1);
    expect(captureDelta('durable', transcript, key, 'claude-code').entries).toEqual([]);
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
