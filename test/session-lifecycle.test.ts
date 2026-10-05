import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { captureDelta, distillDelta } from '../src/core/capture.js';
import { statePath } from '../src/core/home.js';
import { claimJob } from '../src/core/queue.js';
import { setPaused } from '../src/core/session.js';
import { freshCursor } from '../src/core/cursor.js';
import {
  finalizeSession,
  inspectSession,
  maintainSessions,
  observeSession,
  openSession,
} from '../src/core/session-lifecycle.js';
import * as fsModule from '../src/core/fs.js';
import * as locks from '../src/core/lock.js';
import { writeTranscript } from './hook-fixture.js';
import { ageSession, markerFileFor, stateFileFor } from './session-fixture.js';

const project = 'lifecycle-project';
function origin(transcriptPath?: string) {
  return { transcriptPath, host: 'claude-code' as const, project, agent: 'origin' };
}
function end(id: string, transcript?: string) {
  return finalizeSession(id, transcript, project, 'claude-code', loadConfig());
}

afterEach(() => vi.restoreAllMocks());

describe('session lifecycle transitions', () => {
  it('fresh + open(origin) → active; observing values preserves origin', () => {
    expect(inspectSession('new').exists).toBe(false);
    openSession('new', origin('/not-yet-flushed.jsonl'));
    observeSession('new', (state) => {
      state.stop_count = 2;
    });
    expect(inspectSession('new')).toMatchObject({
      exists: true,
      finalized: false,
      state: {
        stop_count: 2,
        transcript_path: '/not-yet-flushed.jsonl',
        project_key: project,
        agent: 'origin',
      },
    });
  });

  it('active + finalize → finalized; unchanged observations cannot resurrect it', () => {
    const transcript = writeTranscript(
      [{ text: 'We decided to retain the final stretch.' }],
      'ended'
    );
    openSession('ended', origin(transcript));
    expect(end('ended', transcript).capturedEntries).toBe(1);
    expect(inspectSession('ended')).toMatchObject({ exists: false, finalized: true });
    expect(
      observeSession('ended', (state) => {
        state.stop_count++;
      })
    ).toEqual({ status: 'retired' });
    expect(end('ended', transcript).capturedEntries).toBe(0);
    expect(inspectSession('ended').exists).toBe(false);
  });

  it.each([false, true])(
    'finalized (paused=%s) + explicit open → resumed generation, marker cursor, unpaused new origin',
    (paused) => {
      const transcript = writeTranscript(
        [{ text: 'We decided to remember only the next stretch.' }],
        'returning'
      );
      openSession('returning', origin(transcript));
      captureDelta('returning', transcript, project, 'claude-code', loadConfig());
      setPaused('returning', paused);
      end('returning', transcript);
      const marker = JSON.parse(fsModule.readFile(markerFileFor('returning'))) as {
        cursor?: ReturnType<typeof freshCursor>;
      };
      expect(openSession('returning', { ...origin(transcript), agent: 'returning' })).toBe(true);
      expect(inspectSession('returning').state).toMatchObject({
        generation: 1,
        cursor: marker.cursor ?? freshCursor(),
        paused: false,
        agent: 'returning',
      });
    }
  );

  it('active pause survives an ordinary explicit open', () => {
    openSession('paused', origin());
    setPaused('paused', true);
    openSession('paused', origin('/later.jsonl'));
    expect(inspectSession('paused').state.paused).toBe(true);
  });

  it('abandoned + maintenance → finalized before the retention sweep can delete its tail', () => {
    const transcript = writeTranscript(
      [{ text: 'We decided to preserve tails before cleanup.' }],
      'old'
    );
    openSession('old', origin(transcript));
    ageSession('old', transcript);
    const result = maintainSessions('current', 'other-project', 'codex', loadConfig(), {
      maxAgeDays: 0,
    });
    expect(result.finalized).toBe(1);
    const job = claimJob('distill-final');
    expect(job?.data['key']).toBe(project);
    expect(job?.data['entries']).toMatchObject([
      {
        text: 'We decided to preserve tails before cleanup.',
        host: 'claude-code',
        agent: 'origin',
      },
    ]);
  });

  it('swept live session + byte growth → resumed generation with its saved pause', () => {
    const transcript = writeTranscript(
      [{ text: 'We decided to pause the quiet stretch.' }],
      'idle'
    );
    openSession('idle', origin(transcript));
    setPaused('idle', true);
    ageSession('idle', transcript);
    expect(maintainSessions('current', project, 'claude-code', loadConfig()).finalized).toBe(1);
    appendFileSync(transcript, '{}\n');
    const later = new Date(Date.now() + 1000);
    utimesSync(transcript, later, later);
    openSession('idle', origin(transcript), 'Stop');
    expect(inspectSession('idle')).toMatchObject({
      exists: true,
      finalized: false,
      state: { generation: 1, paused: true },
    });
  });

  it('late ACP transcript + finalize → pending; later quiet transcript + maintenance → finalized', () => {
    const transcript = statePath('transcripts', 'late.jsonl');
    openSession('late', origin(transcript));
    expect(
      finalizeSession('late', transcript, project, 'claude-code', loadConfig(), {
        deferWhenTranscriptAbsent: true,
      })
    ).toEqual({ capturedEntries: 0, deferred: true });
    expect(inspectSession('late').finalized).toBe(false);
    fsModule.mkdir(statePath('transcripts'));
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'message',
        role: 'user',
        uuid: 'late',
        text: 'We decided to capture the late transcript.',
      }) + '\n'
    );
    ageSession('late', transcript);
    expect(maintainSessions('current', project, 'claude-code', loadConfig()).finalized).toBe(1);
    expect(claimJob('distill-final')?.data['entries']).toMatchObject([
      { text: 'We decided to capture the late transcript.' },
    ]);
  });

  it('open takes one lock, loads state once, and persists once even when resuming and changing origin', () => {
    openSession('once', origin());
    observeSession('once', (state) => {
      state.stop_count = 1;
    });
    end('once');
    const lock = vi.spyOn(locks, 'withSessionLock');
    const read = vi.spyOn(fsModule, 'readFile');
    const write = vi.spyOn(fsModule, 'atomicWrite');
    openSession('once', { ...origin('/new-transcript'), agent: 'new-agent' });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.filter(([path]) => path === markerFileFor('once'))).toHaveLength(1);
    expect(write.mock.calls.filter(([path]) => path === stateFileFor('once'))).toHaveLength(1);
  });

  it('finalization reads the state file once for generation, pause, cursor and origin', () => {
    const transcript = writeTranscript(
      [{ text: 'We decided to finalize from one loaded state.' }],
      'one-read'
    );
    openSession('one-read', origin(transcript));
    const read = vi.spyOn(fsModule, 'readFile');
    const lock = vi.spyOn(locks, 'withSessionLock');
    const write = vi.spyOn(fsModule, 'atomicWrite');
    expect(end('one-read', transcript).capturedEntries).toBe(1);
    expect(read.mock.calls.filter(([path]) => path === stateFileFor('one-read'))).toHaveLength(1);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.filter(([path]) => path === stateFileFor('one-read'))).toHaveLength(0);
    expect(write.mock.calls.filter(([path]) => path === markerFileFor('one-read'))).toHaveLength(1);
  });

  it('maintenance locks and loads each session once across finalization and sweeping', () => {
    const transcript = writeTranscript(
      [{ text: 'We decided to recover with one session snapshot.' }],
      'maintenance'
    );
    openSession('maintenance', origin(transcript));
    ageSession('maintenance', transcript);
    let locked = false;
    let stateReads = 0;
    const withLock = locks.withSessionLock;
    const lock = vi.spyOn(locks, 'withSessionLock').mockImplementation((id, fn) =>
      withLock(id, () => {
        locked = true;
        try {
          return fn();
        } finally {
          locked = false;
        }
      })
    );
    const read = fsModule.readFile;
    vi.spyOn(fsModule, 'readFile').mockImplementation((path) => {
      if (locked && path === stateFileFor('maintenance')) stateReads++;
      return read(path);
    });
    expect(maintainSessions('current', project, 'claude-code', loadConfig()).finalized).toBe(1);
    expect(lock.mock.calls.filter(([id]) => id === 'maintenance')).toHaveLength(1);
    expect(stateReads).toBe(1);
  });

  it('delta preview is read-only and trailing capture is a healthy no-op, not a write failure', () => {
    const transcript = writeTranscript(
      [{ text: 'We decided to keep delta preview read-only.' }],
      'preview'
    );
    expect(distillDelta('preview', transcript, 'claude-code', loadConfig())).toHaveLength(1);
    expect(inspectSession('preview').exists).toBe(false);
    end('preview', transcript);
    expect(captureDelta('preview', transcript, project, 'claude-code', loadConfig())).toEqual({
      appended: 0,
      entries: [],
    });
  });

  it('failed resume persistence restores the marker and leaves the same generation retryable', () => {
    end('rollback');
    const write = fsModule.atomicWrite;
    vi.spyOn(fsModule, 'atomicWrite').mockImplementation((path, content) => {
      if (path === stateFileFor('rollback')) throw new Error('state unavailable');
      write(path, content);
    });
    expect(openSession('rollback', origin('/new'))).toBe(false);
    expect(existsSync(markerFileFor('rollback'))).toBe(true);
    vi.restoreAllMocks();
    expect(openSession('rollback', origin('/new'))).toBe(true);
    expect(inspectSession('rollback').state).toMatchObject({ generation: 1 });
  });
});
