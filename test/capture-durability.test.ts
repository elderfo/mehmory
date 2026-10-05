import { loadConfig } from '../src/core/config.js';
import { finalizeSession, maintainSessions, openSession } from '../src/core/session-lifecycle.js';
import { sessionState, stateFileFor, markerFileFor } from './session-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { captureDelta } from '../src/core/capture.js';
import { statePath } from '../src/core/home.js';
import { readInboxEntries } from '../src/core/inbox.js';
import { claimJob } from '../src/core/queue.js';
import * as fsModule from '../src/core/fs.js';
import {
  advanceSessionCursor,
  incrementStopCount,
  rememberTopic,
  resetStopCount,
  setPaused,
} from '../src/core/session.js';

import { freshSessionState } from '../src/core/session-state.js';
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
    expect(sessionState('durable').cursor.offset).toBe(0);
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
    expect(sessionState('durable').cursor.offset).toBe(0);
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
      if (path === stateFileFor('durable')) throw new Error('cursor write failed');
      write(path, content);
    });
    expect(captureDelta('durable', transcript, key, 'claude-code').failed).toBe(1);
    expect(sessionState('durable').cursor.offset).toBe(0);
    vi.restoreAllMocks();
    expect(captureDelta('durable', transcript, key, 'claude-code').appended).toBe(0);
    expect(readInboxEntries(paths(key).inbox).length).toBe(1);
    expect(sessionState('durable').cursor.offset).toBeGreaterThan(0);
  });

  it('retries the same tail after enqueue fails', () => {
    const original = fsModule.atomicWrite;
    vi.spyOn(fsModule, 'atomicWrite').mockImplementation((path, content) => {
      if (path.startsWith(statePath('queue') + '/')) throw new Error('queue write failed');
      original(path, content);
    });
    expect(finalizeSession('durable', transcript, key, 'claude-code', loadConfig())).toEqual({
      capturedEntries: 0,
      deferred: true,
    });
    expect(sessionState('durable').cursor.offset).toBe(0);
    vi.restoreAllMocks();
    expect(
      finalizeSession('durable', transcript, key, 'claude-code', loadConfig()).capturedEntries
    ).toBe(1);
    expect(
      (claimJob('distill-final')?.data['entries'] as { text: string }[]).map((e) => e.text)
    ).toEqual(['We decided to keep durable capture retries.']);
  });

  it('ordinary mutators and trailing capture never resurrect finalized state', () => {
    finalizeSession('durable', transcript, key, 'claude-code', loadConfig());
    incrementStopCount('durable');
    resetStopCount('durable');
    rememberTopic('durable', new Set(['capture']));
    setPaused('durable', true);
    advanceSessionCursor('durable', transcript, 'last', 1);
    captureDelta('durable', transcript, key, 'claude-code');
    expect(existsSync(stateFileFor('durable'))).toBe(false);
    expect(readInboxEntries(paths(key).inbox)).toEqual([]);
  });

  it('a fresh cursor with an old transcript does not resurrect a swept session', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(transcript, old, old);
    const origin = {
      ...freshSessionState('durable'),
      transcript_path: transcript,
      project_key: key,
      host: 'claude-code' as const,
    };
    openSession('durable', {
      transcriptPath: origin.transcript_path,
      host: origin.host,
      project: origin.project_key,
    });
    finalizeSession('durable', undefined, key, 'claude-code', loadConfig());
    writeFileSync(
      statePath('..', 'config.json'),
      JSON.stringify({ stop: { capture_threshold: 1 } })
    );

    runHook('stop', { session_id: 'durable', transcript_path: transcript }, { cwd });

    expect(existsSync(stateFileFor('durable'))).toBe(false);
    expect(existsSync(markerFileFor('durable'))).toBe(true);
    expect(readInboxEntries(paths(key).inbox)).toEqual([]);
  });

  it.each(['mtime bump', 'truncation'] as const)(
    'a real cursor does not resurrect a swept session after %s without byte growth',
    (change) => {
      captureDelta('durable', transcript, key, 'claude-code');
      writeFileSync(paths(key).inbox, '# Inbox\n');
      finalizeSession('durable', transcript, key, 'claude-code', loadConfig());
      const marker = fsModule.readFile(markerFileFor('durable'));
      if (change === 'truncation') truncateSync(transcript, 10);
      const later = new Date(Date.now() + 1000);
      utimesSync(transcript, later, later);

      runHook('stop', { session_id: 'durable', transcript_path: transcript }, { cwd });
      incrementStopCount('durable');

      expect(existsSync(stateFileFor('durable'))).toBe(false);
      expect(fsModule.readFile(markerFileFor('durable'))).toBe(marker);
      expect(readInboxEntries(paths(key).inbox)).toEqual([]);
    }
  );

  it('keeps a swept live session paused when its transcript grows', () => {
    writeFileSync(
      statePath('..', 'config.json'),
      JSON.stringify({ stop: { capture_threshold: 2 } })
    );
    const input = { session_id: 'durable', transcript_path: transcript };
    runHook('stop', input, { cwd });
    setPaused('durable', true);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stateFileFor('durable'), old, old);
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
    expect(sessionState('durable').paused).toBe(true);
    expect(readInboxEntries(paths(key).inbox)).toEqual([]);
  });

  it('unchanged incomplete transcript tails do not resurrect finalized state', () => {
    appendFileSync(transcript, '{"type":"message"');
    finalizeSession('durable', transcript, key, 'claude-code', loadConfig());
    const marker = fsModule.readFile(markerFileFor('durable'));
    incrementStopCount('durable');
    captureDelta('durable', transcript, key, 'claude-code');
    finalizeSession('durable', transcript, key, 'claude-code', loadConfig());
    expect(existsSync(stateFileFor('durable'))).toBe(false);
    expect(fsModule.readFile(markerFileFor('durable'))).toBe(marker);
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
      utimesSync(stateFileFor('durable'), old, old);
      utimesSync(transcript, old, old);
      runHook('session-start', { session_id: 'sweeper' }, options);
      expect(existsSync(stateFileFor('durable'))).toBe(false);
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
      expect(sessionState('durable').generation).toBe(1);
    }
  );

  it.each(['pre-compact', 'session-end'] as const)(
    '%s resumes a swept session without SessionStart',
    (hook) => {
      runHook('stop', { session_id: 'durable', transcript_path: transcript }, { cwd });
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(stateFileFor('durable'), old, old);
      utimesSync(transcript, old, old);
      expect(
        maintainSessions('sweeper', key, 'claude-code', loadConfig(), { sweep: false }).finalized
      ).toBe(1);
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

  it.each([undefined, { file_id: '', size: 0, offset: 0 }])(
    'ordinary mutations use mtime after finalization when there is no real cursor (%j)',
    (cursor) => {
      openSession('durable', { transcriptPath: transcript, host: 'claude-code', project: key });
      finalizeSession('durable', undefined, key, 'claude-code', loadConfig());
      if (cursor === undefined) {
        // Legacy completion markers may omit the cursor entirely.
        const marker = JSON.parse(fsModule.readFile(markerFileFor('durable'))) as Record<
          string,
          unknown
        >;
        delete marker['cursor'];
        writeFileSync(markerFileFor('durable'), JSON.stringify(marker));
      }
      const later = new Date(Date.now() + 1000);
      utimesSync(transcript, later, later);
      expect(incrementStopCount('durable')).toBe(1);
      expect(sessionState('durable').generation).toBe(1);
      expect(
        captureDelta('durable', transcript, key, 'claude-code').entries.map((e) => e.text)
      ).toEqual(['We decided to keep durable capture retries.']);
    }
  );

  it('SessionStart explicitly resumes from the saved cursor and records the returning agent', () => {
    finalizeSession('durable', transcript, key, 'claude-code', loadConfig());
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
    expect(sessionState('durable').generation).toBe(1);
    expect(sessionState('durable').agent).toBe('returning');
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
    utimesSync(stateFileFor('durable'), old, old);
    utimesSync(transcript, old, old);
    vi.stubEnv('MEHMORY_AGENT', 'sweeper');
    try {
      expect(
        maintainSessions('current', key, 'claude-code', loadConfig(), { sweep: false }).finalized
      ).toBe(1);
      const entries = claimJob('distill-final')?.data['entries'] as { agent?: string }[];
      expect(entries.map((e) => e.agent ?? null)).toEqual([agent || null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
