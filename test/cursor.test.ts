import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { truncateSync } from 'node:fs';
import { advanceCursor, freshCursor, resetCursor, fileIdentity } from '../src/core/cursor.js';
import { atomicWrite, stat } from '../src/core/fs.js';
import { statePath } from '../src/core/home.js';

/**
 * Cursor is now a pure state machine (A13); persistence lives in session.ts, so the
 * rotation/truncation/replay coverage that used to exercise the global cursor.json is
 * split between this file (transitions) and session.test.ts (persistence, interleaving).
 */
describe('cursor', () => {
  let counter = 0;
  function uniqueFile(): string {
    counter++;
    return join(statePath('test-fixtures'), `cursor-test-${String(counter)}.jsonl`);
  }

  it('starts fresh', () => {
    expect(freshCursor()).toEqual({ file_id: '', size: 0, offset: 0 });
  });

  it('advances normally', () => {
    const file = uniqueFile();
    atomicWrite(file, '{"uuid":"rec1"}\n{"uuid":"rec2"}\n');

    const next = advanceCursor(freshCursor(), file, 'hash-of-rec1', 16);

    expect(next.offset).toBe(16);
    expect(next.last_hash).toBe('hash-of-rec1');
    expect(next.file_id).toMatch(/^\d+:\d+$/); // dev:ino
  });

  it('resets the offset on in-place truncation', () => {
    const file = uniqueFile();
    atomicWrite(file, '{"uuid":"rec1"}\n{"uuid":"rec2"}\n');

    const advanced = advanceCursor(freshCursor(), file, 'hash-of-rec2', 32);
    expect(advanced.offset).toBe(32);

    // Truncate IN PLACE. atomicWrite replaces via temp+rename, which changes the inode,
    // so the rotation branch would fire first and truncation would never be reached.
    truncateSync(file, 16);
    expect(stat(file)?.size).toBe(16);

    expect(advanceCursor(advanced, file, 'hash-new', 32).offset).toBe(0);
  });

  it('resets the offset on rotation', () => {
    const first = uniqueFile();
    atomicWrite(first, '{"uuid":"rec1"}\n');
    const advanced = advanceCursor(freshCursor(), first, 'hash-of-rec1', 16);

    const second = uniqueFile();
    atomicWrite(second, '{"uuid":"rec2"}\n');
    const rotated = advanceCursor(advanced, second, 'hash-of-rec2', 16);

    expect(rotated.file_id).not.toBe(advanced.file_id);
    expect(rotated.offset).toBe(0);
  });

  it('keeps the previous identity when the file cannot be statted', () => {
    const file = uniqueFile();
    atomicWrite(file, '{"uuid":"rec1"}\n');
    const advanced = advanceCursor(freshCursor(), file, 'h', 16);

    const missing = join(statePath('test-fixtures'), 'does-not-exist.jsonl');
    expect(fileIdentity(missing)).toBeNull();
    expect(advanceCursor(advanced, missing, 'h2', 24).file_id).toBe(advanced.file_id);
  });

  it('resetCursor clears offset and last_hash', () => {
    const file = uniqueFile();
    atomicWrite(file, '{"uuid":"rec1"}\n');
    const advanced = advanceCursor(freshCursor(), file, 'hash-rec1', 16);

    const reset = resetCursor(advanced);
    expect(reset.offset).toBe(0);
    expect(reset.last_hash).toBeUndefined();
    expect(reset.file_id).toBe(advanced.file_id);
  });
});
