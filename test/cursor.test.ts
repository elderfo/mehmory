import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { truncateSync } from 'node:fs';
import {
  readCursor,
  advanceCursor,
  resetCursor,
} from '../src/core/cursor.js';
import { atomicWrite, stat, pathExists, remove } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';
import { readTranscript } from '../src/transcript/reader.js';
import { distill } from '../src/distill/distill.js';

describe('cursor', () => {
  let testFileCounter = 0;

  // Create unique test file paths to avoid inode reuse issues between tests
  function getUniqueTestFile(): string {
    testFileCounter++;
    return join(statePath('test-fixtures'), `cursor-test-${testFileCounter}.jsonl`);
  }

  function clearCursor(): void {
    const cursorPath = statePath('cursor.json');
    try {
      if (pathExists(cursorPath)) {
        remove(cursorPath);
      }
    } catch {
      // File may not exist, that's fine
    }
  }

  afterEach(() => {
    clearCursor();
  });

  it('reads initial state when cursor file does not exist', () => {
    clearCursor();
    const state = readCursor();
    expect(state).toEqual({
      file_id: '',
      size: 0,
      offset: 0,
    });
  });

  it('advances cursor normally', () => {
    clearCursor();
    const testFile = getUniqueTestFile();
    atomicWrite(testFile, '{"uuid":"rec1"}\n{"uuid":"rec2"}\n');

    advanceCursor(testFile, 'hash-of-rec1', 16);

    const state = readCursor();
    expect(state.offset).toBe(16);
    expect(state.last_hash).toBe('hash-of-rec1');
    expect(state.file_id).toMatch(/^\d+:\d+$/); // dev:ino format
  });

  it('handles mid-line truncation at EOF', () => {
    clearCursor();
    const testFile = getUniqueTestFile();
    atomicWrite(testFile, '{"uuid":"rec1"}\n{"uuid":"incomplete');

    advanceCursor(testFile, 'hash-of-rec1', 16);

    const state = readCursor();
    expect(state.offset).toBe(16);

    // Simulate truncation (file now smaller than offset).
    // Overwrite with smaller content.
    atomicWrite(testFile, '{"uuid":"short"}');

    // In practice, the caller detects truncation and passes newOffset=0.
    // Let's test the full flow:
    advanceCursor(testFile, 'hash-of-rec2', 0); // Caller detected truncation, reset offset
    const newState = readCursor();
    expect(newState.offset).toBe(0);
  });

  it('detects file rotation and resets offset', () => {
    clearCursor();
    const testFile1 = getUniqueTestFile();
    atomicWrite(testFile1, '{"uuid":"rec1"}\n');
    advanceCursor(testFile1, 'hash-of-rec1', 16);

    const state1 = readCursor();
    const oldFileId = state1.file_id;

    // Create a second file (simulating rotation).
    const testFile2 = getUniqueTestFile();
    atomicWrite(testFile2, '{"uuid":"rec2"}\n');

    // Advance with the new file path.
    advanceCursor(testFile2, 'hash-of-rec2', 16);

    const state2 = readCursor();
    expect(state2.file_id).not.toBe(oldFileId);
    // Rotation resets offset to 0 (spec gap 6: "rotation resets offset")
    expect(state2.offset).toBe(0);
  });

  it('resets offset on truncation', () => {
    clearCursor();
    const testFile = getUniqueTestFile();
    atomicWrite(testFile, '{"uuid":"rec1"}\n{"uuid":"rec2"}\n');
    advanceCursor(testFile, 'hash-of-rec1', 16);

    const state1 = readCursor();
    expect(state1.offset).toBe(16);

    // Truncate IN PLACE. atomicWrite would replace the file via temp+rename, which
    // changes the inode, so the rotation branch would fire first and the truncation
    // branch would never be reached — the earlier version of this test passed with
    // the truncation reset deleted for exactly that reason. Real transcripts are
    // truncated in place, so this is the path that actually matters.
    truncateSync(testFile, 8);
    expect(stat(testFile)?.size).toBe(8);

    // Advance with an offset past the new EOF; advanceCursor must detect
    // `current.offset > fileSize` and reset to 0 itself.
    advanceCursor(testFile, 'hash-new', 16);

    const state2 = readCursor();
    expect(state2.offset).toBe(0);
  });

  it('survives invalid JSON in cursor file (fail-open)', () => {
    const cursorPath = statePath('cursor.json');
    atomicWrite(cursorPath, '{invalid}');

    const state = readCursor();
    expect(state).toEqual({
      file_id: '',
      size: 0,
      offset: 0,
    });
  });

  it('full replay produces zero new entries (idempotency)', () => {
    // This is the critical property: replaying a transcript with the same cursor
    // produces no new distilled entries.

    clearCursor();
    // Setup: advance cursor to end of file.
    const testFile = getUniqueTestFile();
    // Records must actually match a distill pattern, otherwise distill returns []
    // and "zero new entries" is trivially true for the wrong reason.
    atomicWrite(
      testFile,
      [
        '{"type":"message","role":"user","text":"first","uuid":"rec1"}',
        '{"type":"message","role":"assistant","text":"reply","uuid":"rec2"}',
        '{"type":"message","role":"user","text":"second","uuid":"rec3"}',
        '',
      ].join('\n')
    );
    const statsResult = stat(testFile);
    if (!statsResult) throw new Error('stat result should exist');
    const fileSize = Number(statsResult.size);

    advanceCursor(testFile, 'hash-of-rec3', fileSize);

    const state1 = readCursor();
    expect(state1.offset).toBe(fileSize);

    // Actually replay: read and distill the whole transcript twice and confirm the
    // second pass yields nothing a consumer would treat as new. Asserting only that
    // cursor state is unchanged (which this test used to do) proves nothing about
    // replay — it would hold even if distill produced duplicate entries every pass.
    const pass1 = distill(readTranscript(testFile).records, 'session-replay');
    expect(pass1.length).toBeGreaterThan(0);

    const seen = new Set(pass1.map(e => e.id));
    const pass2 = distill(readTranscript(testFile).records, 'session-replay');
    const newEntries = pass2.filter(e => !seen.has(e.id));

    expect(pass2).toHaveLength(pass1.length);
    expect(newEntries).toHaveLength(0);

    // Stable IDs are what make that true: same session + same record uuid = same id.
    expect(pass2.map(e => e.id)).toEqual(pass1.map(e => e.id));

    // And the cursor itself is unchanged by re-advancing to the same EOF.
    advanceCursor(testFile, 'hash-of-rec3', fileSize);
    expect(readCursor().offset).toBe(state1.offset);
  });

  it('preserves last_hash for deduplication', () => {
    clearCursor();
    const testFile = getUniqueTestFile();
    atomicWrite(testFile, '{"uuid":"rec1"}\n');

    const hash1 = 'sha256-hash-of-rec1';
    advanceCursor(testFile, hash1, 16);

    let state = readCursor();
    expect(state.last_hash).toBe(hash1);

    // Advance with a different hash.
    const hash2 = 'sha256-hash-of-rec2';
    advanceCursor(testFile, hash2, 32);

    state = readCursor();
    expect(state.last_hash).toBe(hash2);
  });

  it('resetCursor clears offset and last_hash', () => {
    clearCursor();
    const testFile = getUniqueTestFile();
    atomicWrite(testFile, '{"uuid":"rec1"}\n');
    advanceCursor(testFile, 'hash-rec1', 16);

    let state = readCursor();
    expect(state.offset).toBeGreaterThan(0);
    expect(state.last_hash).toBeDefined();

    resetCursor();

    state = readCursor();
    expect(state.offset).toBe(0);
    expect(state.last_hash).toBeUndefined();
  });
});
