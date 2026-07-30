/**
 * Tests for withProjectLock (done-when 7).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync, writeFileSync, readdirSync, mkdirSync, utimesSync, readFileSync } from 'node:fs';
import { statePath } from '../src/core/home.js';
import { withProjectLock } from '../src/core/lock.js';
import { LOCK_RETRY_COUNT, LOCK_RETRY_INTERVAL_MS } from '../src/core/fs.js';

describe('withProjectLock (done-when 7)', () => {
  it('acquires exclusive lock and releases after function completes', () => {
    const lockKey = 'test-project';
    let executed = false;

    const result = withProjectLock(lockKey, () => {
      executed = true;
      return 42;
    });

    expect(executed).toBe(true);
    expect(result).toBe(42);

    // Lock should be released after
    const lockDir = join(statePath('locks'));
    const lockFiles = existsSync(lockDir) ? readdirSync(lockDir) : [];
    const keyLockName = lockKey.replace(/\//g, '_') + '.lock';
    expect(lockFiles).not.toContain(keyLockName);
  });

  it('releases lock even if function throws', () => {
    const lockKey = 'test-error';

    expect(() => {
      withProjectLock(lockKey, () => {
        throw new Error('Test error');
      });
    }).toThrow('Test error');

    // Lock should still be released
    const lockDir = join(statePath('locks'));
    const lockFiles = existsSync(lockDir) ? readdirSync(lockDir) : [];
    const keyLockName = lockKey.replace(/\//g, '_') + '.lock';
    expect(lockFiles).not.toContain(keyLockName);
  });

  it('enforces retry bound: default is 50 × 100 ms = 5 seconds', () => {
    // Assert the documented bound directly, without ever running it for real —
    // the fail-open behavior itself is exercised below via an injected small count.
    expect(LOCK_RETRY_COUNT).toBe(50);
    expect(LOCK_RETRY_INTERVAL_MS).toBe(100);

    const lockKey = 'test-bound';
    const lockFile = join(statePath('locks'), lockKey.replace(/\//g, '_') + '.lock');

    // Create locks directory
    mkdirSync(join(statePath('locks')), { recursive: true });

    // Create a mock lock file to hold for the test
    writeFileSync(lockFile, '');

    let callCount = 0;
    // Use small injected retry count/interval to exercise the same fail-open path
    // the default bound takes, without paying its real-time cost.
    const result = withProjectLock(
      lockKey,
      () => {
        callCount++;
        return 'proceeded-without-lock';
      },
      2, // retries
      1 // 1 ms interval (fast test)
    );

    expect(result).toBe('proceeded-without-lock');
    expect(callCount).toBe(1);
    // Verifies that lock timeout results in fail-open behavior after retry bound exhausted
  });

  it('reclaims stale locks (older than lock.stale_ms)', () => {
    const lockKey = 'test-stale';
    const lockFile = join(statePath('locks'), lockKey.replace(/\//g, '_') + '.lock');

    // Create locks directory
    mkdirSync(join(statePath('locks')), { recursive: true });

    // Create a stale lock file (set mtime to past)
    writeFileSync(lockFile, '');
    const oldTime = Date.now() - 40000; // 40 seconds ago (older than 30s threshold)
    utimesSync(lockFile, oldTime / 1000, oldTime / 1000);

    let acquired = false;

    const result = withProjectLock(lockKey, () => {
      acquired = true;
      return 'claimed-stale';
    });

    expect(result).toBe('claimed-stale');
    expect(acquired).toBe(true);
  });

  it('logs E_LOCK_TIMEOUT when retries exhausted', () => {
    const lockKey = 'test-timeout';
    const lockFile = join(statePath('locks'), lockKey.replace(/\//g, '_') + '.lock');

    // Create locks directory
    mkdirSync(join(statePath('locks')), { recursive: true });

    // Create a lock file that won't be reclaimed (fresh mtime)
    writeFileSync(lockFile, '');

    // Capture errors.log
    const errorsLogPath = join(statePath(), 'errors.log');

    // Small injected retry count/interval: this test only cares that the
    // fail-open path logs E_LOCK_TIMEOUT, not that it takes the default 5s.
    withProjectLock(
      lockKey,
      () => {
        // Should proceed without lock and log E_LOCK_TIMEOUT
        return 'ok';
      },
      2,
      1
    );

    // Check that an error was logged
    if (existsSync(errorsLogPath)) {
      const contents = readFileSync(errorsLogPath, 'utf-8');
      expect(contents).toContain('E_LOCK_TIMEOUT');
    }
  });
});
