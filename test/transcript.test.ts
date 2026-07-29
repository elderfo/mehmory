import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readTranscript } from '../src/transcript/reader.js';
import { atomicWrite } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';

describe('transcript reader', () => {
  it('reads valid JSONL records', () => {
    const testFile = join(
      statePath('test-fixtures'),
      'transcript-valid.jsonl'
    );
    atomicWrite(
      testFile,
      JSON.stringify({ type: 'message', role: 'user', uuid: '1' }) +
        '\n' +
        JSON.stringify({ type: 'message', role: 'assistant', uuid: '2' }) +
        '\n'
    );

    const result = readTranscript(testFile);
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(result.records[0]?.uuid).toBe('1');
  });

  it('skips malformed lines and counts them', () => {
    const testFile = join(statePath('test-fixtures'), 'transcript-bad.jsonl');
    atomicWrite(
      testFile,
      JSON.stringify({ type: 'message', uuid: '1' }) +
        '\n' +
        '{invalid json\n' +
        JSON.stringify({ type: 'message', uuid: '2' }) +
        '\n'
    );

    const result = readTranscript(testFile);
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it('ignores empty lines', () => {
    const testFile = join(statePath('test-fixtures'), 'transcript-empty.jsonl');
    atomicWrite(
      testFile,
      JSON.stringify({ type: 'message', uuid: '1' }) +
        '\n\n' +
        JSON.stringify({ type: 'message', uuid: '2' }) +
        '\n'
    );

    const result = readTranscript(testFile);
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it('handles heterogeneous record types', () => {
    const testFile = join(statePath('test-fixtures'), 'transcript-hetero.jsonl');
    atomicWrite(
      testFile,
      JSON.stringify({ type: 'message', role: 'user', uuid: '1' }) +
        '\n' +
        JSON.stringify({ type: 'mode', mode: 'claude', uuid: '2' }) +
        '\n' +
        JSON.stringify({ type: 'file-history-snapshot', files: [], uuid: '3' }) +
        '\n'
    );

    const result = readTranscript(testFile);
    expect(result.records).toHaveLength(3);
    expect(result.records[0]?.type).toBe('message');
    expect(result.records[1]?.type).toBe('mode');
    expect(result.records[2]?.type).toBe('file-history-snapshot');
  });
});

describe('readTranscript offset (cursor consumer)', () => {
  it('resumes from a byte offset instead of re-reading the file', () => {
    // Regression: readTranscript(path) took no offset, so the cursor's stored
    // offset had no consumer and every pass re-parsed the whole transcript.
    const f = join(statePath('test-fixtures'), 'offset-resume.jsonl');
    const line1 = JSON.stringify({ type: 'message', role: 'user', text: 'one', uuid: 'a' });
    const line2 = JSON.stringify({ type: 'message', role: 'user', text: 'two', uuid: 'b' });
    atomicWrite(f, `${line1}\n${line2}\n`);

    const first = readTranscript(f);
    expect(first.records).toHaveLength(2);
    expect(first.endOffset).toBe(Buffer.byteLength(`${line1}\n${line2}\n`, 'utf-8'));

    // Resuming at the recorded offset yields nothing new — the property the
    // cursor exists to provide.
    const resumed = readTranscript(f, first.endOffset);
    expect(resumed.records).toHaveLength(0);

    // Resuming mid-file yields only the tail.
    const afterFirst = Buffer.byteLength(`${line1}\n`, 'utf-8');
    const tail = readTranscript(f, afterFirst);
    expect(tail.records).toHaveLength(1);
    expect(tail.records[0]?.uuid).toBe('b');
  });

  it('does not consume a trailing partial line', () => {
    const f = join(statePath('test-fixtures'), 'offset-partial.jsonl');
    const complete = JSON.stringify({ type: 'message', role: 'user', text: 'done', uuid: 'c' });
    atomicWrite(f, `${complete}\n{"uuid":"half`);

    const r = readTranscript(f);
    expect(r.records).toHaveLength(1);
    // Offset stops at the end of the last COMPLETE line, so the half-written
    // record is picked up whole on the next pass rather than parsed in two halves.
    expect(r.endOffset).toBe(Buffer.byteLength(`${complete}\n`, 'utf-8'));
  });
});
