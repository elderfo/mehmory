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
