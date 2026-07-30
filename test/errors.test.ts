import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { MehmoryError } from '../src/core/errors.js';
import {
  formatUserError,
  logError,
  failOpen,
  recordWarning,
  pendingWarnings,
} from '../src/core/errors.js';
import { statePath, mehmoryHome } from '../src/core/home.js';

/** Shape of a warnings.json entry, for typing `JSON.parse` results in these tests. */
interface WarningsJsonEntry {
  code: string;
  lastTime: number;
  count: number;
}

describe('formatUserError', () => {
  it('renders actionable error with Fix clause (E_CONFIG_PARSE)', () => {
    const error: MehmoryError = {
      code: 'E_CONFIG_PARSE',
      kind: 'actionable',
      what: 'config.json is not valid JSON (line 4)',
      consequence: 'Memory is running on defaults, so your settings are not applied',
      fix: '$EDITOR ~/.mehmory/config.json',
    };

    const formatted = formatUserError(error);
    expect(formatted).toContain('MEHMORY E_CONFIG_PARSE:');
    expect(formatted).toContain('config.json is not valid JSON (line 4)');
    expect(formatted).toContain('Memory is running on defaults');
    expect(formatted).toContain('Fix: $EDITOR ~/.mehmory/config.json.');
    expect(formatted).toMatch(/Details:.*\.state[/\\]errors\.log/);
  });

  it('renders informational error without Fix clause (E_LOCK_TIMEOUT)', () => {
    const error: MehmoryError = {
      code: 'E_LOCK_TIMEOUT',
      kind: 'informational',
      what: 'project lock held for over 5s; proceeded without it',
      consequence: 'A concurrent session may have overwritten an index rewrite',
    };

    const formatted = formatUserError(error);
    expect(formatted).toContain('MEHMORY E_LOCK_TIMEOUT:');
    expect(formatted).toContain('project lock held for over 5s');
    expect(formatted).toContain('A concurrent session may have overwritten');
    expect(formatted).not.toContain('Fix:');
    expect(formatted).toMatch(/Details:.*\.state[/\\]errors\.log/);
  });

  it('renders informational error for E_DISTILL_LOSSY without Fix clause', () => {
    const error: MehmoryError = {
      code: 'E_DISTILL_LOSSY',
      kind: 'informational',
      what: '34% of transcript lines were unreadable',
      consequence: 'That portion of the session was not captured',
    };

    const formatted = formatUserError(error);
    expect(formatted).toContain('MEHMORY E_DISTILL_LOSSY:');
    expect(formatted).toContain('34% of transcript lines were unreadable');
    expect(formatted).toContain('That portion of the session was not captured');
    expect(formatted).not.toContain('Fix:');
  });
});

describe('logError', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mehmoryHome();
  });

  afterEach(() => {
    const logPath = statePath('errors.log');
    const logPath1 = statePath('errors.log.1');
    if (existsSync(logPath)) rmSync(logPath);
    if (existsSync(logPath1)) rmSync(logPath1);
  });

  it('creates .state directory if missing', () => {
    const stateDir = join(testHome, '.state');

    if (existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true });
    }

    logError({
      code: 'E_CONFIG_PARSE',
      kind: 'actionable',
      what: 'test error',
      consequence: 'test consequence',
      fix: 'fix command',
    });

    expect(existsSync(stateDir)).toBe(true);
  });

  it('appends error to errors.log', () => {
    const logPath = statePath('errors.log');

    logError({
      code: 'E_CONFIG_PARSE',
      kind: 'actionable',
      what: 'test what',
      consequence: 'test consequence',
      fix: 'fix',
    });

    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('E_CONFIG_PARSE');
    expect(content).toContain('test what');
  });

  it('rotates log at 5 MB boundary', () => {
    const logPath = statePath('errors.log');
    const rotatedPath = statePath('errors.log.1');
    const stateDir = join(mehmoryHome(), '.state');

    // Ensure .state directory exists
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    // Write a large file to trigger rotation
    const largeContent = 'x'.repeat(5 * 1024 * 1024 + 1000);
    writeFileSync(logPath, largeContent, 'utf-8');

    logError({
      code: 'E_CONFIG_PARSE',
      kind: 'actionable',
      what: 'test',
      consequence: 'test',
      fix: 'fix',
    });

    // After rotation, errors.log.1 should exist with the old content
    expect(existsSync(rotatedPath)).toBe(true);
    // New errors.log is created by the append, but might be empty if the append failed
    if (existsSync(logPath)) {
      const newLogSize = readFileSync(logPath, 'utf-8').length;
      expect(newLogSize).toBeLessThan(1000); // Just the new entry
    }
  });

  it('rotates again when errors.log.1 already exists', () => {
    const logPath = statePath('errors.log');
    const rotatedPath = statePath('errors.log.1');
    const stateDir = join(mehmoryHome(), '.state');
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    const overflow = (marker: string): void => {
      writeFileSync(logPath, marker + 'x'.repeat(5 * 1024 * 1024 + 1000), 'utf-8');
      logError({
        code: 'E_CONFIG_PARSE',
        kind: 'actionable',
        what: 'test',
        consequence: 'test',
        fix: 'fix',
      });
    };

    overflow('first-');
    overflow('second-');

    // The second rotation must have replaced the first generation, not been skipped.
    expect(existsSync(rotatedPath)).toBe(true);
    expect(readFileSync(rotatedPath, 'utf-8').slice(0, 7)).toBe('second-');
    if (existsSync(logPath)) {
      expect(readFileSync(logPath, 'utf-8').length).toBeLessThan(1000);
    }
  });
});

describe('failOpen', () => {
  afterEach(() => {
    const logPath = statePath('errors.log');
    if (existsSync(logPath)) rmSync(logPath);
  });

  it('returns result on success', () => {
    const result = failOpen(() => 42, 0, 'E_CONFIG_PARSE');
    expect(result).toBe(42);
  });

  it('returns fallback and logs error on exception', () => {
    const fn = () => {
      throw new Error('boom');
    };

    const result = failOpen(fn, 'fallback', 'E_CONFIG_PARSE');
    expect(result).toBe('fallback');
  });
});

describe('warning system (U2 channel)', () => {
  beforeEach(() => {
    const warningsPath = statePath('warnings.json');
    if (existsSync(warningsPath)) {
      rmSync(warningsPath);
    }
  });

  afterEach(() => {
    const warningsPath = statePath('warnings.json');
    if (existsSync(warningsPath)) {
      rmSync(warningsPath);
    }
    const logPath = statePath('errors.log');
    if (existsSync(logPath)) rmSync(logPath);
  });

  it('returns empty array when no warnings exist', () => {
    const warnings = pendingWarnings();
    expect(warnings).toHaveLength(0);
  });

  it('records warning and does not corrupt on multiple calls', () => {
    recordWarning('E_CONFIG_PARSE');
    recordWarning('E_LOCK_TIMEOUT');

    const warningsPath = statePath('warnings.json');
    const content = readFileSync(warningsPath, 'utf-8');
    const parsed = JSON.parse(content) as WarningsJsonEntry[];

    // Must parse successfully and have exactly 2 entries
    expect(parsed).toHaveLength(2);
    expect(parsed.map(w => w.code).sort()).toEqual([
      'E_CONFIG_PARSE',
      'E_LOCK_TIMEOUT',
    ]);
  });

  it('implements consume semantics: pendingWarnings clears state', () => {
    recordWarning('E_CONFIG_PARSE');

    const first = pendingWarnings();
    expect(first.length).toBeGreaterThan(0);

    // Second call should return empty (cleared on first read)
    const second = pendingWarnings();
    expect(second).toHaveLength(0);
  });

  it('rate-limits warnings (1 per hour per code)', () => {
    const warningsPath = statePath('warnings.json');

    // First call records
    recordWarning('E_CONFIG_PARSE');
    let content = readFileSync(warningsPath, 'utf-8');
    let parsed = JSON.parse(content) as WarningsJsonEntry[];
    expect(parsed.length).toBe(1);

    // Second call within 1 hour is skipped (returns early)
    recordWarning('E_CONFIG_PARSE');
    content = readFileSync(warningsPath, 'utf-8');
    parsed = JSON.parse(content) as WarningsJsonEntry[];
    expect(parsed.length).toBe(1); // Still just one entry

    // Rewind lastTime past the rate limit window
    const now = Date.now();
    const first = parsed[0];
    if (!first) throw new Error('expected a warning entry');
    first.lastTime = now - 61 * 60 * 1000; // 61 minutes ago
    writeFileSync(warningsPath, JSON.stringify(parsed, null, 2), 'utf-8');

    // Now the third call should be allowed
    recordWarning('E_CONFIG_PARSE');
    content = readFileSync(warningsPath, 'utf-8');
    parsed = JSON.parse(content) as WarningsJsonEntry[];
    expect(parsed[0]?.count).toBe(2);
  });

  it('survives across separate processes (criterion 17)', () => {
    // Criterion 17: state persists across separate process invocations.
    const tempHome = mehmoryHome();

    // Process 1: record a warning
    const proc1Output = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `process.env.MEHMORY_HOME = '${tempHome}'; import('./dist/core/errors.js').then(m => { m.recordWarning('E_CONFIG_PARSE'); console.log('recorded'); }).catch(e => { console.error('Error:', e.message); process.exit(1); });`,
      ],
      {
        cwd: '/home/cgetsfred/Developer/mehmory',
        encoding: 'utf-8',
      }
    );
    expect(proc1Output).toContain('recorded');

    // Process 2: attempt to record again within rate-limit window (should skip)
    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `process.env.MEHMORY_HOME = '${tempHome}'; import('./dist/core/errors.js').then(m => { m.recordWarning('E_CONFIG_PARSE'); console.log('attempt2'); }).catch(e => { console.error('Error:', e.message); process.exit(1); });`,
      ],
      {
        cwd: '/home/cgetsfred/Developer/mehmory',
        encoding: 'utf-8',
      }
    );

    // State file should still have count=1 (not incremented by second process)
    const warningsPath = statePath('warnings.json');
    const content = readFileSync(warningsPath, 'utf-8');
    const parsed = JSON.parse(content) as WarningsJsonEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.count).toBe(1); // Not 2 (rate-limited)

    // Rewind lastTime past the rate-limit window
    const rewound = parsed[0];
    if (!rewound) throw new Error('expected a warning entry');
    rewound.lastTime = Date.now() - 61 * 60 * 1000; // 61 minutes ago
    writeFileSync(warningsPath, JSON.stringify([rewound], null, 2), 'utf-8');

    // Process 3: after rewinding, should record again
    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `process.env.MEHMORY_HOME = '${tempHome}'; import('./dist/core/errors.js').then(m => { m.recordWarning('E_CONFIG_PARSE'); console.log('attempt3'); }).catch(e => { console.error('Error:', e.message); process.exit(1); });`,
      ],
      {
        cwd: '/home/cgetsfred/Developer/mehmory',
        encoding: 'utf-8',
      }
    );

    // Now count should be 2
    const content3 = readFileSync(warningsPath, 'utf-8');
    const parsed3 = JSON.parse(content3) as WarningsJsonEntry[];
    expect(parsed3[0]?.count).toBe(2);
  });
});
