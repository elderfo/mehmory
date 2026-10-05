import { loadConfig } from '../src/core/config.js';
import {
  finalizeSession,
  inspectSession,
  openSession,
  maintainSessions,
  observeSession,
} from '../src/core/session-lifecycle.js';
import { sessionState, seedSession, stateFileFor, markerFileFor } from './session-fixture.js';
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { utimesSync } from 'node:fs';
import {
  advanceSessionCursor,
  freshSessionState,
  incrementStopCount,
  isPaused,
  rememberTopic,
  resetSessionCursor,
  resetStopCount,
  setPaused,
  topicCacheHit,
} from '../src/core/session.js';
import { atomicWrite, pathExists, readFile } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';
import { readTranscript } from '../src/transcript/reader.js';
import { distill } from '../src/distill/distill.js';
import { tokenize } from '../src/core/match.js';

const key = 'test-project';
function endSession(id: string, cursor?: { file_id: string; size: number; offset: number }): void {
  if (cursor)
    observeSession(id, (state) => {
      state.cursor = cursor;
    });
  finalizeSession(id, undefined, key, 'claude-code', loadConfig());
}
function isFinalized(id: string): boolean {
  return inspectSession(id).finalized;
}

describe('session state', () => {
  it('returns fresh state for an unknown session', () => {
    expect(sessionState('brand-new')).toEqual(freshSessionState('brand-new'));
  });

  it('round-trips through disk', () => {
    const state = freshSessionState('s1');
    state.stop_count = 4;
    state.project_key = 'github.com/acme/repo';
    seedSession(state);

    const read = sessionState('s1');
    expect(read.stop_count).toBe(4);
    expect(read.project_key).toBe('github.com/acme/repo');
    expect(read.paused).toBe(false);
  });

  it('resets corrupt state to fresh and logs, never throwing', () => {
    atomicWrite(stateFileFor('corrupt'), '{ not json');

    let state = freshSessionState('x');
    expect(() => (state = sessionState('corrupt'))).not.toThrow();
    expect(state).toEqual(freshSessionState('corrupt'));

    expect(readFile(statePath('errors.log'))).toContain('E_SESSION_STATE');
  });

  it('resets structurally invalid state (valid JSON, wrong shape)', () => {
    atomicWrite(stateFileFor('wrong-shape'), JSON.stringify({ session_id: 'x' }));
    expect(sessionState('wrong-shape')).toEqual(freshSessionState('wrong-shape'));
  });

  it('counts Stop invocations and resets on capture', () => {
    expect(incrementStopCount('s2')).toBe(1);
    expect(incrementStopCount('s2')).toBe(2);
    resetStopCount('s2');
    expect(sessionState('s2').stop_count).toBe(0);
  });

  it('stores the pause flag', () => {
    setPaused('s3', true);
    expect(isPaused('s3')).toBe(true);
    setPaused('s3', false);
    expect(isPaused('s3')).toBe(false);
  });

  it('records transcript, host and project key as the session origin', () => {
    openSession(
      's5',
      { transcriptPath: '/tmp/t.jsonl', host: 'claude-code', project: 'github.com/acme/repo' },
      'Stop'
    );
    const state = sessionState('s5');
    expect(state.transcript_path).toBe('/tmp/t.jsonl');
    expect(state.host).toBe('claude-code');
    expect(state.project_key).toBe('github.com/acme/repo');
  });

  // Both arms of the guard: a payload really can carry `transcript_path: ''`, and neither
  // shape has anything a later sweep could finalize, so neither should leave state behind.
  it.each([undefined, ''])('ignores an origin with no transcript to finalize (%p)', (path) => {
    openSession(
      's6',
      { transcriptPath: path, host: 'claude-code', project: 'github.com/acme/repo' },
      'Stop'
    );
    expect(pathExists(stateFileFor('s6'))).toBe(false);
  });

  // Last write wins, deliberately. `project_key` is read by exactly one consumer -- the
  // deferred-finalize fallback -- and what it scopes is the transcript tail after the last
  // Stop, which was produced under the most recent cwd. Pinning the first key instead would
  // file that tail under the project it demonstrably was not written in.
  it('rewrites the origin when the same session reports a new project key', () => {
    openSession(
      's7',
      { transcriptPath: '/tmp/t.jsonl', host: 'claude-code', project: 'github.com/acme/first' },
      'Stop'
    );
    openSession(
      's7',
      { transcriptPath: '/tmp/t.jsonl', host: 'claude-code', project: 'github.com/acme/second' },
      'Stop'
    );
    expect(sessionState('s7').project_key).toBe('github.com/acme/second');
  });

  // `project_key` is joined under `<home>/projects/`, so the state file is a read
  // boundary: a key that climbs out of the store must not survive the parse.
  it.each(['../../../../tmp/pwned', '/etc/passwd', 'ok/..', '', 'a/./b'])(
    'drops a project_key that would escape the store (%p)',
    (bad) => {
      atomicWrite(
        stateFileFor('s8'),
        JSON.stringify({ ...freshSessionState('s8'), project_key: bad })
      );
      expect(sessionState('s8').project_key).toBeUndefined();
    }
  );

  it('keeps a one-segment project_key, which is a supported alias shape', () => {
    atomicWrite(
      stateFileFor('s9'),
      JSON.stringify({ ...freshSessionState('s9'), project_key: 'my-custom-key' })
    );
    expect(sessionState('s9').project_key).toBe('my-custom-key');
  });

  // A trailing hook for a finalized session would otherwise rebuild its state from
  // `freshSessionState` -- cursor at 0 -- and `finalizeSession` never deletes it again.
  it('does not resurrect state for a session that was already finalized', () => {
    endSession('s10');
    expect(isFinalized('s10')).toBe(true);

    openSession(
      's10',
      { transcriptPath: '/tmp/t.jsonl', host: 'claude-code', project: 'github.com/acme/repo' },
      'Stop'
    );

    expect(pathExists(stateFileFor('s10'))).toBe(false);
  });

  it('deletes its own state file', () => {
    seedSession(freshSessionState('s4'));
    expect(pathExists(stateFileFor('s4'))).toBe(true);
    finalizeSession('s4', undefined, key, 'claude-code', loadConfig());
    expect(pathExists(stateFileFor('s4'))).toBe(false);
    expect(() => {
      finalizeSession('s4', undefined, key, 'claude-code', loadConfig());
    }).not.toThrow();
  });

  describe('topic cache', () => {
    const thresholds = { jaccard: 0.7, ttlMs: 300000 };

    it('hits on a near-identical prompt inside the TTL', () => {
      rememberTopic('t1', tokenize('how does the deploy pipeline handle rollback'), 1000);
      const state = sessionState('t1');

      const similar = tokenize('how does the deploy pipeline handle rollback again');
      expect(topicCacheHit(state, similar, 2000, thresholds)).toBe(true);
    });

    it('misses on a different topic', () => {
      rememberTopic('t2', tokenize('deploy pipeline rollback'), 1000);
      const state = sessionState('t2');

      expect(topicCacheHit(state, tokenize('database migration ordering'), 2000, thresholds)).toBe(
        false
      );
    });

    it('misses once the TTL has elapsed', () => {
      rememberTopic('t3', tokenize('deploy pipeline rollback'), 1000);
      const state = sessionState('t3');

      const same = tokenize('deploy pipeline rollback');
      expect(topicCacheHit(state, same, 1000 + thresholds.ttlMs + 1, thresholds)).toBe(false);
    });

    it('misses when nothing is cached', () => {
      expect(topicCacheHit(freshSessionState('t4'), tokenize('anything'), 0, thresholds)).toBe(
        false
      );
    });
  });

  describe('sweep', () => {
    it('deletes stale session files and keeps fresh ones and non-session files', () => {
      seedSession(freshSessionState('stale'));
      seedSession(freshSessionState('recent'));
      atomicWrite(statePath('warnings.json'), '[]');

      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(stateFileFor('stale'), old, old);
      utimesSync(statePath('warnings.json'), old, old);

      expect(
        maintainSessions('current', key, 'claude-code', loadConfig(), {
          finalizePending: false,
          maxAgeDays: 14,
        }).swept
      ).toBe(1);
      expect(pathExists(stateFileFor('stale'))).toBe(false);
      expect(pathExists(stateFileFor('recent'))).toBe(true);
      expect(pathExists(statePath('warnings.json'))).toBe(true);
    });

    // A marker ends in `.json` and carries a `session_id`, so it matches the sweep's own
    // filter. Removing one while its state file survives un-finalizes that session: the
    // state re-qualifies as pending and the transcript is distilled a second time.
    it('never removes a finalization marker while its state file is still there', () => {
      endSession('paired');
      // Legacy partial cleanup: state survives beside a completed marker.
      atomicWrite(stateFileFor('paired'), JSON.stringify(freshSessionState('paired')));

      const marker = markerFileFor('paired');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);

      expect(
        maintainSessions('current', key, 'claude-code', loadConfig(), {
          finalizePending: false,
          maxAgeDays: 14,
        }).swept
      ).toBe(0);
      expect(pathExists(marker)).toBe(true);
      expect(isFinalized('paired')).toBe(true);
    });

    it('removes a marker whose paired state file is unparseable', () => {
      // A malformed state file is skipped by its own iteration and is invisible to
      // pending recovery, so it can never un-finalize anything. Pinning the marker
      // behind it would strand both files permanently.
      endSession('mangled');
      atomicWrite(stateFileFor('mangled'), '{ not json');

      const marker = markerFileFor('mangled');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);

      expect(
        maintainSessions('current', key, 'claude-code', loadConfig(), {
          finalizePending: false,
          maxAgeDays: 14,
        }).swept
      ).toBe(1);
      expect(pathExists(marker)).toBe(false);
    });

    it('removes a marker once its state file is gone', () => {
      endSession('orphaned-marker');

      const marker = markerFileFor('orphaned-marker');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);

      expect(
        maintainSessions('current', key, 'claude-code', loadConfig(), {
          finalizePending: false,
          maxAgeDays: 14,
        }).swept
      ).toBe(1);
      expect(pathExists(marker)).toBe(false);
    });
  });

  describe('resume: a finalized id that comes back', () => {
    it('clears the marker so the resumed run can be finalized again', () => {
      endSession('resumed');
      expect(isFinalized('resumed')).toBe(true);

      expect(openSession('resumed')).toBe(true);
      expect(isFinalized('resumed')).toBe(false);
    });

    it('hands the cursor back so the resumed run does not re-read the transcript', () => {
      const cursor = { file_id: '1:2', size: 4096, offset: 4096 };
      endSession('resumed-cursor', cursor);

      openSession('resumed-cursor');

      expect(sessionState('resumed-cursor').cursor).toEqual(cursor);
    });

    it('does not clobber live state if one somehow already exists', () => {
      const live = { ...freshSessionState('resumed-live'), stop_count: 3 };
      seedSession(live);
      // A stale marker coexists with live state only after a partial legacy write.
      atomicWrite(
        markerFileFor('resumed-live'),
        JSON.stringify({
          session_id: 'resumed-live',
          cursor: { file_id: '1:2', size: 10, offset: 10 },
        })
      );

      openSession('resumed-live');

      expect(sessionState('resumed-live').stop_count).toBe(3);
    });

    it('bumps the generation so the second ending is not read as a retry of the first', () => {
      endSession('gen');
      openSession('gen');
      expect(sessionState('gen').generation).toBe(1);

      endSession('gen');
      openSession('gen');
      expect(sessionState('gen').generation).toBe(2);
    });

    it('reports false for a session that was never finalized', () => {
      expect(openSession('never-finalized')).toBe(false);
    });

    it('clears an unreadable marker rather than leaving the id unfinalizable', () => {
      atomicWrite(markerFileFor('mangled-marker'), '{ not json');
      expect(openSession('mangled-marker')).toBe(true);
      expect(isFinalized('mangled-marker')).toBe(false);
    });
  });

  describe('a busy session is not an abandoned one', () => {
    const aged = Date.now() / 1000 - 6 * 60 * 60;

    function pendingSession(id: string, transcript: string): void {
      seedSession({ ...freshSessionState(id), transcript_path: transcript });
      utimesSync(stateFileFor(id), aged, aged);
    }

    function activeSession(id: string, transcript: string): void {
      atomicWrite(transcript, '{}\n');
      seedSession({ ...freshSessionState(id), transcript_path: transcript });
    }

    it('leaves a session alone while its transcript is still growing', () => {
      // No hook has written state for six hours, which is what one long tool call looks
      // like. The transcript says the session is very much alive.
      const transcript = statePath('busy.jsonl');
      atomicWrite(transcript, '{}\n');
      pendingSession('busy', transcript);
      activeSession('active', statePath('active.jsonl'));

      expect(
        maintainSessions('active', key, 'claude-code', loadConfig(), { sweep: false }).finalized
      ).toBe(0);
    });

    it('finalizes a session once its transcript has gone quiet too', () => {
      const transcript = statePath('quiet.jsonl');
      atomicWrite(transcript, '{}\n');
      pendingSession('quiet', transcript);
      utimesSync(transcript, aged, aged);
      activeSession('active', statePath('active.jsonl'));

      expect(
        maintainSessions('active', key, 'claude-code', loadConfig(), { sweep: false }).finalized
      ).toBe(1);
      expect(inspectSession('quiet').finalized).toBe(true);
    });

    it('still finalizes a session whose transcript never landed (#43)', () => {
      // `stat` throws on a missing path rather than returning undefined, and the catch
      // around this loop would swallow it and drop the session entirely -- which is
      // exactly the not-yet-flushed ACP rollout that has to stay eligible.
      pendingSession('unflushed', statePath('never-written.jsonl'));
      activeSession('active', statePath('active.jsonl'));

      expect(
        maintainSessions('active', key, 'claude-code', loadConfig(), { sweep: false }).finalized
      ).toBe(1);
      expect(inspectSession('unflushed').finalized).toBe(true);
    });
  });

  describe('interleaved sessions (A13: the run-1 global-cursor blocker)', () => {
    it('never resets the other session cursor and never re-distills', () => {
      const transcriptA = join(statePath('fixtures'), 'a.jsonl');
      const transcriptB = join(statePath('fixtures'), 'b.jsonl');

      const line = (session: string, uuid: string, text: string): string =>
        JSON.stringify({ type: 'message', role: 'user', text, uuid, sessionId: session });

      atomicWrite(transcriptA, [line('A', 'a1', 'we will use postgres'), ''].join('\n'));
      atomicWrite(transcriptB, [line('B', 'b1', "let's use redis for the cache"), ''].join('\n'));

      const seen = new Set<string>();
      const captured: string[] = [];

      // Alternating A/B/A/B captures, each appending one record to its own transcript.
      const captureFrom = (session: string, transcript: string): void => {
        const state = sessionState(session);
        const result = readTranscript(transcript, state.cursor.offset);
        for (const entry of distill(result.records)) {
          if (!seen.has(entry.id)) {
            seen.add(entry.id);
            captured.push(entry.id);
          } else {
            throw new Error(`re-distilled ${entry.id} — cursor was reset by the other session`);
          }
        }
        advanceSessionCursor(session, transcript, 'h', result.endOffset);
      };

      captureFrom('A', transcriptA);
      captureFrom('B', transcriptB);

      // Each session appends one more record, then both capture again.
      atomicWrite(
        transcriptA,
        [
          line('A', 'a1', 'we will use postgres'),
          line('A', 'a2', 'decision: shard by tenant'),
          '',
        ].join('\n')
      );
      atomicWrite(
        transcriptB,
        [
          line('B', 'b1', "let's use redis for the cache"),
          line('B', 'b2', 'decision: ttl is 5 minutes'),
          '',
        ].join('\n')
      );

      // atomicWrite replaces the inode, which is a rotation — the cursor resets to 0
      // and replays, but stable ids make the replay a no-op, so `captured` must not
      // gain duplicates. What must never happen is one session's capture resetting the
      // OTHER session's offset.
      const offsetABefore = sessionState('A').cursor.offset;
      captureFrom('B', transcriptB);
      expect(sessionState('A').cursor.offset).toBe(offsetABefore);

      const offsetBBefore = sessionState('B').cursor.offset;
      captureFrom('A', transcriptA);
      expect(sessionState('B').cursor.offset).toBe(offsetBBefore);

      expect(captured.length).toBe(4);
      expect(new Set(captured).size).toBe(4);
    });
  });

  it('replay from a reset cursor produces no new entry ids (idempotency)', () => {
    const transcript = join(statePath('fixtures'), 'replay.jsonl');
    atomicWrite(
      transcript,
      [
        '{"type":"message","role":"user","text":"first","uuid":"rec1","sessionId":"R"}',
        '{"type":"message","role":"user","text":"we will ship on friday","uuid":"rec2","sessionId":"R"}',
        '',
      ].join('\n')
    );

    const first = readTranscript(transcript, sessionState('R').cursor.offset);
    const pass1 = distill(first.records);
    expect(pass1.length).toBeGreaterThan(0);
    advanceSessionCursor('R', transcript, 'h', first.endOffset);
    expect(sessionState('R').cursor.offset).toBe(first.endOffset);

    resetSessionCursor('R');
    const pass2 = distill(readTranscript(transcript, sessionState('R').cursor.offset).records);

    expect(pass2.map((e) => e.id)).toEqual(pass1.map((e) => e.id));
  });
});
