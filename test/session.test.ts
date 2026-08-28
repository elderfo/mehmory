import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { utimesSync } from 'node:fs';
import {
  advanceSessionCursor,
  deleteSessionState,
  freshSessionState,
  incrementStopCount,
  isPaused,
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

  it('ignores an origin with no transcript to finalize', () => {
    rememberSessionOrigin('s6', undefined, 'claude-code', 'github.com/acme/repo');
    expect(pathExists(sessionStatePath('s6'))).toBe(false);
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
