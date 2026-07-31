import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { distill } from '../src/distill/distill.js';
import type { TranscriptRecord } from '../src/transcript/reader.js';

/**
 * Compute the stable ID that distill() should produce.
 */
function computeId(sessionId: string, recordUuid: string): string {
  return createHash('sha256')
    .update(sessionId)
    .update(recordUuid)
    .digest('hex');
}

describe('distill', () => {
  const SESSION_ID = 'test-session-abc123';

  it('extracts user messages', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'Can you refactor this code?',
        uuid: 'msg-001',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    const entry = result[0];
    if (!entry) throw new Error('expected one entry');
    expect(entry.pattern).toBe('user_message');
    expect(entry.content).toContain('refactor');
    expect(entry.id).toBe(computeId(SESSION_ID, 'msg-001'));
  });

  it('extracts decision markers with "decide" keyword', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'I decide to use TypeScript for this project.',
        uuid: 'msg-002',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.pattern).toBe('decision_marker');
    expect(result[0]?.content).toContain('Decision:');
  });

  it('extracts decision markers with "let\'s" keyword', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: "Let's implement a new feature here.",
        uuid: 'msg-003',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.pattern).toBe('decision_marker');
  });

  it('extracts correction patterns', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'Actually, that should be done differently.',
        uuid: 'msg-004',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.pattern).toBe('correction_pattern');
    expect(result[0]?.content).toContain('Correction:');
  });

  it('extracts error resolutions', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'The build is failing with this error. Let me fix it.',
        uuid: 'msg-005',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.pattern).toBe('error_resolution');
    expect(result[0]?.content).toContain('Error resolution:');
  });

  it('skips records without uuid', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'This has no uuid',
        // no uuid field
      },
    ];

    const result = distill(records, SESSION_ID);
    expect(result).toHaveLength(0);
  });

  it('skips assistant messages', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'assistant',
        text: 'Here is my response',
        uuid: 'msg-006',
      },
    ];

    const result = distill(records, SESSION_ID);
    expect(result).toHaveLength(0);
  });

  it('skips non-message records', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'mode',
        mode: 'claude',
        uuid: 'mode-001',
      },
      {
        type: 'file-history-snapshot',
        files: [],
        uuid: 'snap-001',
      },
    ];

    const result = distill(records, SESSION_ID);
    expect(result).toHaveLength(0);
  });

  it('uses first matching pattern (decision over generic user message)', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'I decide to do this.',
        uuid: 'msg-007',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    // decision_marker matches first
    expect(result[0]?.pattern).toBe('decision_marker');
  });

  it('includes source metadata', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'Hello',
        uuid: 'msg-008',
      },
    ];

    const result = distill(records, SESSION_ID);
    expect(result).toHaveLength(1);

    expect(result[0]?.source).toEqual({
      sessionId: SESSION_ID,
      recordUuid: 'msg-008',
      recordType: 'message',
      lineNumber: 0,
    });
  });

  it('produces stable IDs across multiple invocations', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: 'Decide to use this approach.',
        uuid: 'msg-stable',
      },
    ];

    const result1 = distill(records, SESSION_ID);
    const result2 = distill(records, SESSION_ID);

    expect(result1[0]?.id).toBe(result2[0]?.id);
  });

  it('truncates long content to 500 chars', () => {
    const longText = 'x'.repeat(1000);
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        text: longText,
        uuid: 'msg-long',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result[0]?.content.length).toBeLessThanOrEqual(505); // 500 + "...", or with pattern prefix
  });

  it('handles content array (ChatML structure)', () => {
    const records: TranscriptRecord[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.' },
        ],
        uuid: 'msg-array',
      },
    ];

    const result = distill(records, SESSION_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain('First part');
    expect(result[0]?.content).toContain('Second part');
  });
});

describe('distill redaction (write path)', () => {
  it('redacts secrets before they enter a distilled entry', () => {
    // Regression: redact() was applied only in injection.ts, on the way OUT of the
    // store. By then the secret is already written to a markdown page and committed
    // to the store's git history, where a filtered read cannot remove it.
    const records = [
      {
        type: 'message',
        role: 'user',
        text: 'deploy with AKIAIOSFODNN7EXAMPLE please',
        uuid: 'sec-1',
      },
    ];

    const entries = distill(records, 'session-redact');

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error('expected one entry');
    expect(entry.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(entry.content).toContain('[REDACTED]');
  });

  it('leaves ordinary prose untouched', () => {
    const records = [
      { type: 'message', role: 'user', text: 'refactor the parser', uuid: 'plain-1' },
    ];
    const entries = distill(records, 'session-redact');
    const [entry] = entries;
    if (!entry) throw new Error('expected one entry');
    expect(entry.content).toBe('refactor the parser');
  });
});

/**
 * Criterion 6: ids key on the RECORD-embedded sessionId. On resume Claude Code hands a
 * new session id a transcript that still contains the previous session's records; if
 * ids keyed on the invoking session, every resume would re-append the whole history.
 */
describe('distill stable ids across resume', () => {
  const priorRecords: TranscriptRecord[] = [
    {
      type: 'message',
      role: 'user',
      text: 'we will use postgres',
      uuid: 'msg-001',
      sessionId: 'session-original',
    },
    {
      type: 'message',
      role: 'user',
      text: 'decision: shard by tenant',
      uuid: 'msg-002',
      sessionId: 'session-original',
    },
  ];

  it('keys ids on the record sessionId, not the invoking session', () => {
    const entries = distill(priorRecords, 'session-original');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toBe(computeId('session-original', 'msg-001'));
    expect(entries[0]?.source.sessionId).toBe('session-original');
  });

  it('produces zero duplicate entries when replayed under a new session id', () => {
    const beforeResume = distill(priorRecords, 'session-original');

    // Resume: new invoking session, same records (plus a new one from the new session).
    const afterResume = distill(
      [
        ...priorRecords,
        {
          type: 'message',
          role: 'user',
          text: 'decision: ttl is five minutes',
          uuid: 'msg-003',
          sessionId: 'session-resumed',
        },
      ],
      'session-resumed'
    );

    const seen = new Set(beforeResume.map(e => e.id));
    const fresh = afterResume.filter(e => !seen.has(e.id));

    expect(afterResume).toHaveLength(3);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.id).toBe(computeId('session-resumed', 'msg-003'));
  });

  it('falls back to the invoking session id for records with no sessionId', () => {
    const entries = distill(
      [{ type: 'message', role: 'user', text: 'legacy record', uuid: 'msg-legacy' }],
      'session-invoking'
    );
    expect(entries[0]?.id).toBe(computeId('session-invoking', 'msg-legacy'));
  });
  it('applies the user\'s own secrets.patterns, not just the built-ins', () => {
    // The debt run 3 closes: without the threaded options a direct consumer of
    // `./distill/distill` got built-in patterns only, so a pattern the user configured
    // never reached the one place content is first materialized.
    const records: TranscriptRecord[] = [
      { type: 'message', role: 'user', text: 'deploy key SEKRET-4711 goes here', uuid: 'msg-secret' },
    ];

    expect(distill(records, 'session-secrets')[0]?.content).toContain('SEKRET-4711');
    expect(
      distill(records, 'session-secrets', { patterns: ['/SEKRET-[0-9]+/g'] })[0]?.content
    ).toBe('deploy key [REDACTED] goes here');
  });
});
