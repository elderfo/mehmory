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
        text: 'Hello, can you look at this?',
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
      [
        {
          type: 'message',
          role: 'user',
          text: 'a legacy record with no sessionId',
          uuid: 'msg-legacy',
        },
      ],
      'session-invoking'
    );
    expect(entries[0]?.id).toBe(computeId('session-invoking', 'msg-legacy'));
  });

  it('drops turns too thin to be memory', () => {
    // The `user_message` pattern matches every user turn unconditionally, so without a
    // floor there is no retention decision anywhere in the pipeline and menu picks land
    // in the inbox. One real store held seven consecutive one-letter entries.
    const thin = ['A', 'yes', 'agreed', 'Ship it', 'confirm', 'code .'];
    const records: TranscriptRecord[] = thin.map((text, i) => ({
      type: 'message',
      role: 'user',
      text,
      uuid: `msg-thin-${String(i)}`,
    }));

    expect(distill(records, 'session-thin')).toEqual([]);
  });

  it('keeps short turns in scripts that do not separate words with spaces', () => {
    // A word count would read each of these as a single "word" and drop a complete
    // durable fact. Losing the user's own words is the worse failure: a junk entry is
    // visible and deletable at integrate time, a dropped fact leaves no signal at all.
    const cjk = ['デプロイにはVPNが必要です', '部署需要先连接VPN'];
    const records: TranscriptRecord[] = cjk.map((text, i) => ({
      type: 'message',
      role: 'user',
      text,
      uuid: `msg-cjk-${String(i)}`,
    }));

    expect(distill(records, 'session-cjk').map(e => e.content)).toEqual(cjk);
  });

  it('keeps a substantial single-token turn', () => {
    // A pasted URL or a spaceless log line carries no whitespace but is not noise.
    const url = 'https://github.com/elderfo/mehmory/blob/main/src/distill/patterns.ts#L46';
    const entries = distill(
      [{ type: 'message', role: 'user', text: url, uuid: 'msg-url' }],
      'session-url'
    );

    expect(entries.map(e => e.content)).toEqual([url]);
  });

  it('drops harness notification blocks however the tag is spelled', () => {
    // The bare-lowercase form matched only the exact shape observed, so a capitalized
    // tag, an attribute, or a space before `>` passed through and was filed verbatim.
    // Captured text is re-injected into later sessions, so machine text reaching the
    // store is an injection surface that persists, not just clutter.
    const shapes = [
      '<task-notification>\n<task-id>abc123</task-id>\n</task-notification>',
      '<Task-Notification>machine text here</Task-Notification>',
      '<task-notification id="1">machine text here</task-notification>',
      '<task-notification >machine text here</task-notification>',
      '<system-reminder>a block truncated mid-transcript with no closing tag',
    ];
    const records: TranscriptRecord[] = shapes.map((content, i) => ({
      type: 'user',
      message: { role: 'user', content },
      uuid: `msg-notif-${String(i)}`,
    }));

    expect(distill(records, 'session-notif')).toEqual([]);
  });

  it('keeps prose that quotes a harness tag name inline', () => {
    // Anchoring matters: an unanchored paired match deletes everything between the two
    // mentions, which is exactly the turn someone working on this file types.
    const text = 'strip <system-reminder> blocks the way we strip </system-reminder> ones';
    const entries = distill(
      [{ type: 'user', message: { role: 'user', content: text }, uuid: 'msg-quote' }],
      'session-quote'
    );

    expect(entries.map(e => e.content)).toEqual([text]);
  });

  it('drops slash-command envelopes but keeps their arguments', () => {
    // Claude Code writes these as `type: 'user'` with no `isMeta` flag, so the meta
    // filter never saw them and the inbox filled with /reload-plugins transcripts.
    const records: TranscriptRecord[] = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/reload-plugins</command-name>\n<command-args></command-args>',
        },
        uuid: 'msg-cmd',
      },
      {
        type: 'user',
        message: { role: 'user', content: '<local-command-stdout>✓ Installed mehmory.</local-command-stdout>' },
        uuid: 'msg-stdout',
      },
      {
        type: 'user',
        message: { role: 'user', content: '<bash-input>pnpm test</bash-input>\n<bash-stdout>ok</bash-stdout>' },
        uuid: 'msg-bash',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/orchestrate</command-name>\n<command-args>build the thing</command-args>',
        },
        uuid: 'msg-args',
      },
    ];

    const entries = distill(records, 'session-cmd');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe('build the thing');
  });

  it('keeps user prose that shares a record with a command echo', () => {
    // One record routinely carries both — a /clear echo, then what the user typed after.
    // Dropping the whole turn on an envelope match would silently eat the prose, and any
    // turn that merely quotes one of these tag names while discussing it.
    const records: TranscriptRecord[] = [
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/clear</command-name>\n<local-command-stdout></local-command-stdout>\nthe deploy needs the VPN',
        },
        uuid: 'msg-mixed',
      },
      {
        type: 'user',
        message: { role: 'user', content: 'why does distill drop <command-name> turns?' },
        uuid: 'msg-quoting',
      },
    ];

    const entries = distill(records, 'session-mixed');
    expect(entries.map(e => e.content)).toEqual([
      'the deploy needs the VPN',
      'why does distill drop <command-name> turns?',
    ]);
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
