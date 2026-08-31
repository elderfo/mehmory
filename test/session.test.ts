import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { utimesSync } from 'node:fs';
import {
  advanceSessionCursor,
  deleteSessionState,
  freshSessionState,
  incrementStopCount,
  isPaused,
  isSessionFinalized,
  listPendingSessions,
  resumeFinalizedSession,
  markSessionFinalized,
  readSessionState,
  rememberTopic,
  resetSessionCursor,
  resetStopCount,
  sessionStatePath,
  rememberSessionOrigin,
  setPaused,
  sweepSessionState,
  topicCacheHit,
  writeSessionState,
} from '../src/core/session.js';
import { atomicWrite, pathExists, readFile } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';
import { readTranscript } from '../src/transcript/reader.js';
import { distill } from '../src/distill/distill.js';
import { tokenize } from '../src/core/match.js';

describe('session state', () => {
  it('returns fresh state for an unknown session', () => {
    expect(readSessionState('brand-new')).toEqual(freshSessionState('brand-new'));
  });

  it('round-trips through disk', () => {
    const state = freshSessionState('s1');
    state.stop_count = 4;
    state.project_key = 'github.com/acme/repo';
    writeSessionState(state);

    const read = readSessionState('s1');
    expect(read.stop_count).toBe(4);
    expect(read.project_key).toBe('github.com/acme/repo');
    expect(read.paused).toBe(false);
  });

  it('resets corrupt state to fresh and logs, never throwing', () => {
    atomicWrite(sessionStatePath('corrupt'), '{ not json');

    let state = freshSessionState('x');
    expect(() => (state = readSessionState('corrupt'))).not.toThrow();
    expect(state).toEqual(freshSessionState('corrupt'));

    expect(readFile(statePath('errors.log'))).toContain('E_SESSION_STATE');
  });

  it('resets structurally invalid state (valid JSON, wrong shape)', () => {
    atomicWrite(sessionStatePath('wrong-shape'), JSON.stringify({ session_id: 'x' }));
    expect(readSessionState('wrong-shape')).toEqual(freshSessionState('wrong-shape'));
  });

  it('counts Stop invocations and resets on capture', () => {
    expect(incrementStopCount('s2')).toBe(1);
    expect(incrementStopCount('s2')).toBe(2);
    resetStopCount('s2');
    expect(readSessionState('s2').stop_count).toBe(0);
  });

  it('stores the pause flag', () => {
    setPaused('s3', true);
    expect(isPaused('s3')).toBe(true);
    setPaused('s3', false);
    expect(isPaused('s3')).toBe(false);
  });

  it('records transcript, host and project key as the session origin', () => {
    rememberSessionOrigin('s5', '/tmp/t.jsonl', 'claude-code', 'github.com/acme/repo');
    const state = readSessionState('s5');
    expect(state.transcript_path).toBe('/tmp/t.jsonl');
    expect(state.host).toBe('claude-code');
    expect(state.project_key).toBe('github.com/acme/repo');
  });

  // Both arms of the guard: a payload really can carry `transcript_path: ''`, and neither
  // shape has anything a later sweep could finalize, so neither should leave state behind.
  it.each([undefined, ''])('ignores an origin with no transcript to finalize (%p)', path => {
    rememberSessionOrigin('s6', path, 'claude-code', 'github.com/acme/repo');
    expect(pathExists(sessionStatePath('s6'))).toBe(false);
  });

  // Last write wins, deliberately. `project_key` is read by exactly one consumer -- the
  // deferred-finalize fallback -- and what it scopes is the transcript tail after the last
  // Stop, which was produced under the most recent cwd. Pinning the first key instead would
  // file that tail under the project it demonstrably was not written in.
  it('rewrites the origin when the same session reports a new project key', () => {
    rememberSessionOrigin('s7', '/tmp/t.jsonl', 'claude-code', 'github.com/acme/first');
    rememberSessionOrigin('s7', '/tmp/t.jsonl', 'claude-code', 'github.com/acme/second');
    expect(readSessionState('s7').project_key).toBe('github.com/acme/second');
  });

  // `project_key` is joined under `<home>/projects/`, so the state file is a read
  // boundary: a key that climbs out of the store must not survive the parse.
  it.each(['../../../../tmp/pwned', '/etc/passwd', 'ok/..', '', 'a/./b'])(
    'drops a project_key that would escape the store (%p)',
    bad => {
      atomicWrite(
        sessionStatePath('s8'),
        JSON.stringify({ ...freshSessionState('s8'), project_key: bad })
      );
      expect(readSessionState('s8').project_key).toBeUndefined();
    }
  );

  it('keeps a one-segment project_key, which is a supported alias shape', () => {
    atomicWrite(
      sessionStatePath('s9'),
      JSON.stringify({ ...freshSessionState('s9'), project_key: 'my-custom-key' })
    );
    expect(readSessionState('s9').project_key).toBe('my-custom-key');
  });

  // A trailing hook for a finalized session would otherwise rebuild its state from
  // `freshSessionState` -- cursor at 0 -- and `finalizeSession` never deletes it again.
  it('does not resurrect state for a session that was already finalized', () => {
    markSessionFinalized('s10');
    expect(isSessionFinalized('s10')).toBe(true);

    rememberSessionOrigin('s10', '/tmp/t.jsonl', 'claude-code', 'github.com/acme/repo');

    expect(pathExists(sessionStatePath('s10'))).toBe(false);
  });

  it('deletes its own state file', () => {
    writeSessionState(freshSessionState('s4'));
    expect(pathExists(sessionStatePath('s4'))).toBe(true);
    deleteSessionState('s4');
    expect(pathExists(sessionStatePath('s4'))).toBe(false);
    expect(() => {
      deleteSessionState('s4');
    }).not.toThrow();
  });

  describe('topic cache', () => {
    const thresholds = { jaccard: 0.7, ttlMs: 300000 };

    it('hits on a near-identical prompt inside the TTL', () => {
      rememberTopic('t1', tokenize('how does the deploy pipeline handle rollback'), 1000);
      const state = readSessionState('t1');

      const similar = tokenize('how does the deploy pipeline handle rollback again');
      expect(topicCacheHit(state, similar, 2000, thresholds)).toBe(true);
    });

    it('misses on a different topic', () => {
      rememberTopic('t2', tokenize('deploy pipeline rollback'), 1000);
      const state = readSessionState('t2');

      expect(topicCacheHit(state, tokenize('database migration ordering'), 2000, thresholds)).toBe(
        false
      );
    });

    it('misses once the TTL has elapsed', () => {
      rememberTopic('t3', tokenize('deploy pipeline rollback'), 1000);
      const state = readSessionState('t3');

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
      writeSessionState(freshSessionState('stale'));
      writeSessionState(freshSessionState('recent'));
      atomicWrite(statePath('warnings.json'), '[]');

      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(sessionStatePath('stale'), old, old);
      utimesSync(statePath('warnings.json'), old, old);

      expect(sweepSessionState(14)).toBe(1);
      expect(pathExists(sessionStatePath('stale'))).toBe(false);
      expect(pathExists(sessionStatePath('recent'))).toBe(true);
      expect(pathExists(statePath('warnings.json'))).toBe(true);
    });

    // A marker ends in `.json` and carries a `session_id`, so it matches the sweep's own
    // filter. Removing one while its state file survives un-finalizes that session: the
    // state re-qualifies as pending and the transcript is distilled a second time.
    it('never removes a finalization marker while its state file is still there', () => {
      markSessionFinalized('paired');
      writeSessionState(freshSessionState('paired'));

      const marker = statePath('paired.finalized.json');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);

      expect(sweepSessionState(14)).toBe(0);
      expect(pathExists(marker)).toBe(true);
      expect(isSessionFinalized('paired')).toBe(true);
    });

    it('removes a marker whose paired state file is unparseable', () => {
      // A malformed state file is skipped by its own iteration and is invisible to
      // `listPendingSessions`, so it can never un-finalize anything. Pinning the marker
      // behind it would strand both files permanently.
      markSessionFinalized('mangled');
      atomicWrite(sessionStatePath('mangled'), '{ not json');

      const marker = statePath('mangled.finalized.json');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);

      expect(sweepSessionState(14)).toBe(1);
      expect(pathExists(marker)).toBe(false);
    });

    it('removes a marker once its state file is gone', () => {
      markSessionFinalized('orphaned-marker');

      const marker = statePath('orphaned-marker.finalized.json');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);

      expect(sweepSessionState(14)).toBe(1);
      expect(pathExists(marker)).toBe(false);
    });
  });

  describe('resume: a finalized id that comes back', () => {
    it('clears the marker so the resumed run can be finalized again', () => {
      markSessionFinalized('resumed');
      expect(isSessionFinalized('resumed')).toBe(true);

      expect(resumeFinalizedSession('resumed')).toBe(true);
      expect(isSessionFinalized('resumed')).toBe(false);
    });

    it('hands the cursor back so the resumed run does not re-read the transcript', () => {
      const cursor = { file_id: '1:2', size: 4096, offset: 4096 };
      markSessionFinalized('resumed-cursor', cursor);

      resumeFinalizedSession('resumed-cursor');

      expect(readSessionState('resumed-cursor').cursor).toEqual(cursor);
    });

    it('does not clobber live state if one somehow already exists', () => {
      const live = { ...freshSessionState('resumed-live'), stop_count: 3 };
      writeSessionState(live);
      markSessionFinalized('resumed-live', { file_id: '1:2', size: 10, offset: 10 });

      resumeFinalizedSession('resumed-live');

      expect(readSessionState('resumed-live').stop_count).toBe(3);
    });

    it('bumps the generation so the second ending is not read as a retry of the first', () => {
      markSessionFinalized('gen', undefined, 0);
      resumeFinalizedSession('gen');
      expect(readSessionState('gen').generation).toBe(1);

      markSessionFinalized('gen', undefined, 1);
      resumeFinalizedSession('gen');
      expect(readSessionState('gen').generation).toBe(2);
    });

    it('reports false for a session that was never finalized', () => {
      expect(resumeFinalizedSession('never-finalized')).toBe(false);
    });

    it('clears an unreadable marker rather than leaving the id unfinalizable', () => {
      atomicWrite(statePath('mangled-marker.finalized.json'), '{ not json');
      expect(resumeFinalizedSession('mangled-marker')).toBe(true);
      expect(isSessionFinalized('mangled-marker')).toBe(false);
    });
  });


  describe('a busy session is not an abandoned one', () => {
    const aged = Date.now() / 1000 - 6 * 60 * 60;

    function pendingSession(id: string, transcript: string): void {
      writeSessionState({ ...freshSessionState(id), transcript_path: transcript });
      utimesSync(sessionStatePath(id), aged, aged);
    }

    it('leaves a session alone while its transcript is still growing', () => {
      // No hook has written state for six hours, which is what one long tool call looks
      // like. The transcript says the session is very much alive.
      const transcript = statePath('busy.jsonl');
      atomicWrite(transcript, '{}\n');
      pendingSession('busy', transcript);

      expect(listPendingSessions().map(p => p.session_id)).not.toContain('busy');
    });

    it('finalizes a session once its transcript has gone quiet too', () => {
      const transcript = statePath('quiet.jsonl');
      atomicWrite(transcript, '{}\n');
      pendingSession('quiet', transcript);
      utimesSync(transcript, aged, aged);

      expect(listPendingSessions().map(p => p.session_id)).toContain('quiet');
    });

    it('still finalizes a session whose transcript never landed (#43)', () => {
      // `stat` throws on a missing path rather than returning undefined, and the catch
      // around this loop would swallow it and drop the session entirely -- which is
      // exactly the not-yet-flushed ACP rollout that has to stay eligible.
      pendingSession('unflushed', statePath('never-written.jsonl'));

      expect(listPendingSessions().map(p => p.session_id)).toContain('unflushed');
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
        const state = readSessionState(session);
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
        [line('A', 'a1', 'we will use postgres'), line('A', 'a2', 'decision: shard by tenant'), ''].join(
          '\n'
        )
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
      const offsetABefore = readSessionState('A').cursor.offset;
      captureFrom('B', transcriptB);
      expect(readSessionState('A').cursor.offset).toBe(offsetABefore);

      const offsetBBefore = readSessionState('B').cursor.offset;
      captureFrom('A', transcriptA);
      expect(readSessionState('B').cursor.offset).toBe(offsetBBefore);

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

    const first = readTranscript(transcript, readSessionState('R').cursor.offset);
    const pass1 = distill(first.records);
    expect(pass1.length).toBeGreaterThan(0);
    advanceSessionCursor('R', transcript, 'h', first.endOffset);
    expect(readSessionState('R').cursor.offset).toBe(first.endOffset);

    resetSessionCursor('R');
    const pass2 = distill(readTranscript(transcript, readSessionState('R').cursor.offset).records);

    expect(pass2.map(e => e.id)).toEqual(pass1.map(e => e.id));
  });
});
