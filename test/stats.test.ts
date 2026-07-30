import { describe, it, expect } from 'vitest';
import { lastStatFor, recordStat, statsPath } from '../src/core/stats.js';
import { atomicWrite, pathExists, readFile } from '../src/core/fs.js';

describe('recordStat', () => {
  it('appends one JSONL line per invocation with the criterion-16 fields', () => {
    recordStat({ project: 'github.com/acme/repo', hook: 'SessionStart', ms: 42 });
    recordStat({
      project: 'github.com/acme/repo',
      hook: 'UserPromptSubmit',
      ms: 7,
      pointers_offered: 2,
    });

    const lines = readFile(statsPath()).trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(first['project']).toBe('github.com/acme/repo');
    expect(first['hook']).toBe('SessionStart');
    expect(first['ms']).toBe(42);
    expect(typeof first['ts']).toBe('string');
    expect(new Date(String(first['ts'])).toString()).not.toBe('Invalid Date');

    const second = JSON.parse(lines[1] ?? '') as Record<string, unknown>;
    expect(second['pointers_offered']).toBe(2);
  });

  it('keeps a caller-supplied timestamp', () => {
    recordStat({ ts: '2020-01-01T00:00:00.000Z', project: 'p', hook: 'Stop', ms: 1 });
    expect(lastStatFor('p', 'Stop')?.ts).toBe('2020-01-01T00:00:00.000Z');
  });

  it('rotates past the configured size, keeping one generation', () => {
    // 6 MB of filler puts the file over the 5 MB default before the next append.
    atomicWrite(statsPath(), 'x'.repeat(6 * 1024 * 1024));

    recordStat({ project: 'p', hook: 'Stop', ms: 1 });

    expect(pathExists(`${statsPath()}.1`)).toBe(true);
    const lines = readFile(statsPath()).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('rotates again when a previous generation is already on disk', () => {
    const oversized = (): void => {
      atomicWrite(statsPath(), 'x'.repeat(6 * 1024 * 1024));
    };

    oversized();
    recordStat({ project: 'p', hook: 'Stop', ms: 1 });
    oversized();
    recordStat({ project: 'p', hook: 'Stop', ms: 2 });

    // The second rotation must have happened: the live file holds only the new line,
    // and the single kept generation is the one that was just moved aside.
    expect(readFile(statsPath()).trim().split('\n')).toHaveLength(1);
    expect(pathExists(`${statsPath()}.1`)).toBe(true);
    expect(lastStatFor('p', 'Stop')?.ms).toBe(2);
  });

  it('never throws when the stats path is unwritable', () => {
    expect(() => {
      recordStat({ project: 'p', hook: 'Stop', ms: 1 });
    }).not.toThrow();
  });
});

describe('lastStatFor', () => {
  it('returns the newest matching entry', () => {
    recordStat({ project: 'p1', hook: 'SessionStart', ms: 1 });
    recordStat({ project: 'p2', hook: 'SessionStart', ms: 2 });
    recordStat({ project: 'p1', hook: 'SessionStart', ms: 3 });
    recordStat({ project: 'p1', hook: 'Stop', ms: 4 });

    expect(lastStatFor('p1', 'SessionStart')?.ms).toBe(3);
    expect(lastStatFor('p2', 'SessionStart')?.ms).toBe(2);
  });

  it('returns undefined when there is no match or no file', () => {
    expect(lastStatFor('nobody', 'SessionStart')).toBeUndefined();
    recordStat({ project: 'p1', hook: 'Stop', ms: 1 });
    expect(lastStatFor('p1', 'SessionStart')).toBeUndefined();
  });

  it('skips unparseable lines', () => {
    recordStat({ project: 'p1', hook: 'Stop', ms: 1 });
    atomicWrite(statsPath(), `${readFile(statsPath())}{ torn write\n`);

    expect(lastStatFor('p1', 'Stop')?.ms).toBe(1);
  });
});
