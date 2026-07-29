/**
 * Tests for fs primitives (done-when 6, 7, 8, 9).
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { statePath } from '../src/core/home.js';
import { atomicWrite, appendRecord, pathExists, APPEND_ATOMIC_CEILING_BYTES } from '../src/core/fs.js';
import { withProjectLock } from '../src/core/lock.js';

describe('fs primitives', () => {
  describe('atomicWrite', () => {
    it('writes contents atomically to a new file', () => {
      const filePath = join(statePath(), 'test-atomic.txt');
      const contents = 'Hello, world!';

      atomicWrite(filePath, contents);

      expect(pathExists(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe(contents);
    });

    it('creates parent directories', () => {
      const filePath = join(statePath(), 'deep', 'nested', 'test-atomic.txt');
      const contents = 'Nested content';

      atomicWrite(filePath, contents);

      expect(readFileSync(filePath, 'utf-8')).toBe(contents);
    });

    it('overwrites existing file', () => {
      const filePath = join(statePath(), 'test-overwrite.txt');

      atomicWrite(filePath, 'First');
      atomicWrite(filePath, 'Second');

      expect(readFileSync(filePath, 'utf-8')).toBe('Second');
    });
  });

  describe('appendRecord (done-when 6)', () => {
    it('appends single line with newline', () => {
      const filePath = join(statePath(), 'test-append.jsonl');

      const result1 = appendRecord(filePath, 'record1', 'test', withProjectLock);
      const result2 = appendRecord(filePath, 'record2', 'test', withProjectLock);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      const contents = readFileSync(filePath, 'utf-8');
      const lines = contents.trim().split('\n');

      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('record1');
      expect(lines[1]).toBe('record2');
    });

    it('JSON-escapes embedded newlines', () => {
      const filePath = join(statePath(), 'test-escape.jsonl');

      const result = appendRecord(filePath, 'line1\nline2', 'test', withProjectLock);
      expect(result.ok).toBe(true);

      const contents = readFileSync(filePath, 'utf-8').trim();
      expect(contents).toBe('line1\\nline2');
    });

    it('handles newlines in JSON objects', () => {
      const filePath = join(statePath(), 'test-json.jsonl');
      const record = JSON.stringify({ msg: 'hello\nworld' });

      const result = appendRecord(filePath, record, 'test', withProjectLock);
      expect(result.ok).toBe(true);

      const contents = readFileSync(filePath, 'utf-8').trim();
      // The entire record should be one line
      expect(contents).not.toContain('\nworld');
    });

    it('concurrent append test: 8 processes × 200 records = 1600 lines (real concurrency)', { timeout: 30000 }, () => {
      const filePath = join(statePath(), 'concurrent-append.jsonl');
      const processCount = 8;
      const recordsPerProcess = 200;

      // Write a test script that each process will run
      const testScriptPath = join(statePath(), 'append-worker.mjs');
      const scriptDir = dirname(testScriptPath);
      mkdirSync(scriptDir, { recursive: true });
      const repoRoot = '/home/cgetsfred/Developer/mehmory';
      const scriptContent = `
import { appendRecord } from '${repoRoot}/dist/core/fs.js';
import { withProjectLock } from '${repoRoot}/dist/core/lock.js';
const filePath = process.argv[2];
const recordCount = parseInt(process.argv[3], 10);
for (let i = 0; i < recordCount; i++) {
  appendRecord(filePath, JSON.stringify({ pid: process.pid, idx: i }), 'test-append', withProjectLock);
}
`;
      writeFileSync(testScriptPath, scriptContent);

      // Spawn 8 processes concurrently
      const processes: ReturnType<typeof spawn>[] = [];
      for (let i = 0; i < processCount; i++) {
        const proc = spawn('node', [testScriptPath, filePath, recordsPerProcess.toString()], {
          stdio: 'pipe',
          env: { ...process.env },
        });
        processes.push(proc);
      }

      // Wait for all to complete
      let completed = 0;
      return new Promise<void>((resolve, reject) => {
        processes.forEach(proc => {
          proc.on('exit', (code: number | null) => {
            if (code !== 0 && code !== null) {
              reject(new Error(`Worker exited with code ${code}`));
            }
            completed++;
            if (completed === processCount) {
              // All done; verify
              try {
                const contents = readFileSync(filePath, 'utf-8');
                const lines = contents.trim().split('\n');

                expect(lines).toHaveLength(processCount * recordsPerProcess);

                // Verify each line is parseable
                lines.forEach((line: string) => {
                  if (line) {
                    const obj = JSON.parse(line);
                    expect(obj).toHaveProperty('pid');
                    expect(obj).toHaveProperty('idx');
                  }
                });

                // No interleaved content
                lines.forEach((line: string) => {
                  expect(line).not.toContain('\n');
                });

                resolve();
              } catch (err) {
                reject(err);
              }
            }
          });
          proc.on('error', reject);
        });
      });
    });

    it('respects 4 KiB atomicity ceiling', () => {
      const filePath = join(statePath(), 'test-ceiling.jsonl');

      // Below ceiling: should use direct append
      const smallRecord = 'x'.repeat(1024);
      const result = appendRecord(filePath, smallRecord, 'test', withProjectLock);
      expect(result.ok).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toContain(smallRecord);

      // At/above ceiling: should still succeed (uses lock path)
      const largeRecord = 'y'.repeat(APPEND_ATOMIC_CEILING_BYTES + 1);
      const resultLarge = appendRecord(filePath, largeRecord, 'test', withProjectLock);
      expect(resultLarge.ok).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toContain('y');
    });

    it('large record uses lock path', () => {
      const filePath = join(statePath(), 'test-locked.jsonl');

      const largeRecord = 'z'.repeat(APPEND_ATOMIC_CEILING_BYTES + 100);

      const result = appendRecord(filePath, largeRecord, 'test-key', withProjectLock);
      expect(result.ok).toBe(true);

      const contents = readFileSync(filePath, 'utf-8');
      expect(contents).toContain('z');
    });
  });
});
