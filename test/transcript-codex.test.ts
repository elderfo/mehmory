import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readCodexRollout } from '../src/transcript/codex.js';
import { readTranscript } from '../src/transcript/reader.js';
import { readSession } from '../src/transcript/host.js';
import { atomicWrite } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';

/** One event-envelope line, the shape a real rollout is written in. */
function envelope(timestamp: string, payload: Record<string, unknown>, type = 'event_msg'): string {
  return JSON.stringify({ timestamp, type, payload });
}

const userMsg = (ts: string, message: string): string =>
  envelope(ts, { type: 'user_message', message, images: [], local_images: [] });

describe('codex rollout reader', () => {
  it('normalizes user and agent events into the distiller record shape', () => {
    const f = join(statePath('test-fixtures'), 'codex-normalize.jsonl');
    atomicWrite(
      f,
      [
        envelope('2026-05-01T00:00:00.000Z', { id: 'roll-1', cwd: '/home/u/proj' }, 'session_meta'),
        userMsg('2026-05-01T00:00:01.000Z', 'ship it'),
        envelope('2026-05-01T00:00:02.000Z', { type: 'agent_message', message: 'on it' }),
      ].join('\n') + '\n'
    );

    const { records, skipped } = readCodexRollout(f);
    expect(skipped).toBe(0);
    expect(records).toHaveLength(2);
    // The normalized shape is the one distill's patterns already match on.
    expect(records[0]).toMatchObject({ type: 'message', role: 'user', text: 'ship it' });
    expect(records[1]).toMatchObject({ type: 'message', role: 'assistant', text: 'on it' });
    // session_meta.id is the rollout uuid, which is what a hook reports as session_id.
    expect(records[0]?.sessionId).toBe('roll-1');
    expect(typeof records[0]?.uuid).toBe('string');
  });

  it('ignores non-conversation payloads without counting them as losses', () => {
    // Most of a rollout is tool traffic. Counting it as skipped would trip
    // E_DISTILL_LOSSY on every pass over a perfectly healthy file.
    const f = join(statePath('test-fixtures'), 'codex-noise.jsonl');
    atomicWrite(
      f,
      [
        envelope('2026-05-01T00:00:00.000Z', { type: 'token_count', info: null }),
        envelope('2026-05-01T00:00:01.000Z', { type: 'function_call' }, 'response_item'),
        // The API-level echo of the same turn: read as well, every user message
        // would be filed twice.
        envelope(
          '2026-05-01T00:00:02.000Z',
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
          'response_item'
        ),
        userMsg('2026-05-01T00:00:02.000Z', 'hello'),
      ].join('\n') + '\n'
    );

    const { records, skipped } = readCodexRollout(f);
    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
  });

  it('survives malformed lines and a truncated tail', () => {
    const f = join(statePath('test-fixtures'), 'codex-torn.jsonl');
    const good = userMsg('2026-05-01T00:00:01.000Z', 'first');
    atomicWrite(f, `${good}\n{"timestamp":"2026-05\n17\n{"timestamp":"2026-05-01T00:00:03`);

    const { records, skipped, endOffset } = readCodexRollout(f);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(2);
    // The half-written record is left for the next pass, not parsed in halves.
    expect(endOffset).toBe(Buffer.byteLength(`${good}\n{"timestamp":"2026-05\n17\n`, 'utf-8'));
  });

  it('resumes from a byte offset and mints the same uuid either way', () => {
    // The cursor property Codex needs as much as Claude Code does: a resumed pass
    // starts mid-file and must still produce the ids the first pass would have,
    // or every resume re-files the whole session.
    const f = join(statePath('test-fixtures'), 'codex-resume.jsonl');
    const meta = envelope('2026-05-01T00:00:00.000Z', { id: 'roll-2' }, 'session_meta');
    const one = userMsg('2026-05-01T00:00:01.000Z', 'one');
    const two = userMsg('2026-05-01T00:00:02.000Z', 'two');
    atomicWrite(f, `${meta}\n${one}\n${two}\n`);

    const first = readCodexRollout(f);
    expect(first.records).toHaveLength(2);
    expect(readCodexRollout(f, first.endOffset).records).toHaveLength(0);

    const tail = readCodexRollout(f, Buffer.byteLength(`${meta}\n${one}\n`, 'utf-8'));
    expect(tail.records).toHaveLength(1);
    expect(tail.records[0]?.uuid).toBe(first.records[1]?.uuid);
    // session_meta is behind the offset, so the record falls back to the caller's
    // session id rather than inventing one.
    expect(tail.records[0]?.sessionId).toBeUndefined();
  });

  it('fails the same way as the Claude Code reader on a missing file', () => {
    // Quiet survival is the caller's failOpen boundary, shared by both readers —
    // a second, divergent one here would be a second fail-open policy.
    const missing = join(statePath('test-fixtures'), 'codex-nope.jsonl');
    expect(() => readCodexRollout(missing)).toThrow();
    expect(() => readTranscript(missing)).toThrow();
  });
});

describe('readSession (reader selection by host)', () => {
  it('parses the same bytes differently per host', () => {
    const f = join(statePath('test-fixtures'), 'codex-select.jsonl');
    atomicWrite(f, userMsg('2026-05-01T00:00:01.000Z', 'pick me') + '\n');

    expect(readSession(f, 'codex').records[0]?.text).toBe('pick me');
    // As a Claude Code transcript the same line is just an opaque record: the
    // envelope is passed through untouched, no `text` field in sight.
    expect(readSession(f, 'claude-code').records[0]?.text).toBeUndefined();
    expect(readSession(f, 'claude-code').records[0]?.type).toBe('event_msg');
  });
});
