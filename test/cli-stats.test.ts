/**
 * `mehmory stats` — criterion 10. Named `cli-stats` rather than `stats` because
 * `test/stats.test.ts` is run 1's core-module suite for `recordStat`/`lastStatFor`.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { percentile, summarize } from '../src/core/stats-report.js';
import type { StatRecord } from '../src/core/stats.js';
import { envelopeOf, runCli } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

describe('percentile arithmetic', () => {
  it('matches a hand-computed nearest-rank fixture', () => {
    // 10 samples: p50 is the 5th (ceil(0.5·10)=5), p95 the 10th (ceil(0.95·10)=10).
    const values = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(100);

    // 4 samples: p50 is the 2nd (ceil(2)=2), p95 the 4th (ceil(3.8)=4).
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);

    // A single sample is both percentiles; an empty set has neither.
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it('aggregates only fields the records actually carry', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const records: StatRecord[] = [
      { ts, project: 'p', hook: 'SessionStart', ms: 10, injected_tokens: 100 },
      { ts, project: 'p', hook: 'SessionStart', ms: 30, injected_tokens: 300 },
      { ts, project: 'p', hook: 'UserPromptSubmit', ms: 5, pointers_offered: 2 },
      { ts, project: 'p', hook: 'Stop', ms: 7, captured_entries: 4 },
    ];
    const report = summarize(records);

    expect(report.records).toBe(4);
    expect(report.hooks.map(h => h.hook)).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(report.hooks[0]).toMatchObject({ count: 2, msP50: 10, msP95: 30 });
    expect(report.injectedTokensP50).toBe(100);
    expect(report.injectedTokensP95).toBe(300);
    expect(report.pointersOffered).toBe(2);
    expect(report.capturedEntries).toBe(4);
  });

  it('breaks captures down by harness (issue #14 story 39)', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const records: StatRecord[] = [
      { ts, project: 'p', hook: 'Stop', ms: 1, host: 'claude-code', captured_entries: 3 },
      { ts, project: 'p', hook: 'Stop', ms: 1, host: 'claude-code', captured_entries: 2 },
      { ts, project: 'p', hook: 'Stop', ms: 1, host: 'codex', captured_entries: 5 },
      { ts, project: 'p', hook: 'SessionStart', ms: 1 }, // no captured_entries: still counts a call
    ];
    const report = summarize(records);

    expect(report.hosts).toEqual([
      { host: 'claude-code', count: 2, capturedEntries: 5 },
      { host: 'codex', count: 1, capturedEntries: 5 },
    ]);
  });
});

describe('mehmory stats', () => {
  it('exits 2 when there is no store', () => {
    expect(runCli(['stats']).status).toBe(2);
  });

  it('reports the current project by default', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const key = String(
      (envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>)['key']
    );
    writeStats([
      stat(key, 'SessionStart', 10, { injected_tokens: 400 }),
      stat(key, 'SessionStart', 50, { injected_tokens: 800 }),
      stat(key, 'UserPromptSubmit', 4, { pointers_offered: 3 }),
      stat('other/project', 'SessionStart', 999, { injected_tokens: 9999 }),
    ]);

    const run = runCli(['stats'], { cwd });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('records  3');
    expect(run.stdout).toContain('SessionStart');
    expect(run.stdout).toContain('p50 400 tokens');
    expect(run.stdout).toContain('pointers   3 offered');
    // The other project's 999 ms record must not leak into this scope.
    expect(run.stdout).not.toContain('999');
  });

  it('reports captures per harness in both text and --json (issue #14 story 39)', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const key = String(
      (envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>)['key']
    );
    writeStats([
      stat(key, 'Stop', 1, { host: 'claude-code', captured_entries: 2 }),
      stat(key, 'Stop', 1, { host: 'codex', captured_entries: 5 }),
    ]);

    const run = runCli(['stats'], { cwd });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('claude-code');
    expect(run.stdout).toContain('codex');

    const data = envelopeOf(runCli(['stats', '--json'], { cwd }))['data'] as Record<
      string,
      unknown
    >;
    expect(data['hosts']).toEqual([
      { host: 'claude-code', count: 1, capturedEntries: 2 },
      { host: 'codex', count: 1, capturedEntries: 5 },
    ]);
  });

  it('`--all` spans every project', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    seedProject('github.com/acme/widgets');
    writeStats([
      stat('github.com/acme/widgets', 'Stop', 1, { captured_entries: 5 }),
      stat('unlisted/project', 'Stop', 2, { captured_entries: 7 }),
    ]);
    const data = envelopeOf(runCli(['stats', '--all', '--json'], { cwd }))['data'] as Record<
      string,
      unknown
    >;
    expect(data['scope']).toBe('all');
    expect(data['records']).toBe(2);
    expect(data['capturedEntries']).toBe(12);
  });

  it('`--since` drops older records', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    writeStats([
      { ...stat('k', 'Stop', 1), ts: '2026-01-01T00:00:00.000Z' },
      { ...stat('k', 'Stop', 2), ts: '2026-07-01T00:00:00.000Z' },
    ]);
    const data = envelopeOf(
      runCli(['stats', '--all', '--since', '2026-06-01T00:00:00.000Z', '--json'], { cwd })
    )['data'] as Record<string, unknown>;
    expect(data['records']).toBe(1);
  });

  it('rejects a non-ISO `--since` with exit 1', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const run = runCli(['stats', '--since', 'yesterday'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not an ISO-8601 timestamp');
  });

  it('accepts `--global` as a flag but rejects it as a scope, with exit 1', () => {
    // Criterion 12: a command that cannot act on a scope rejects it, rather than
    // failing to parse it — the difference between "wrong scope" and "typo".
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const run = runCli(['stats', '--global'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('stats.jsonl is keyed by project');
    expect(run.stderr).toContain('Fix: mehmory stats --all');
  });

  it('rejects combined scope flags with exit 1', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const run = runCli(['stats', '--all', '--global'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cannot be combined');
  });

  it('reports inbox age and integrate cadence from the files that carry them', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const key = 'github.com/acme/widgets';
    const dir = seedProject(key);
    writeFileSync(
      join(dir, 'log.md'),
      '# Log\n\n## 2026-07-01T00:00:00.000Z integrate | a\n## 2026-07-05T00:00:00.000Z integrate | b\n'
    );
    writeStats([stat(key, 'Stop', 1)]);

    const data = envelopeOf(runCli(['stats', '--all', '--json'], { cwd }))['data'] as Record<
      string,
      unknown
    >;
    // Two integrates four days apart: one every 4.0 days.
    expect(data['integrateCadenceDays']).toBeCloseTo(4, 5);
    expect(typeof data['inboxAgeMs']).toBe('number');
  });
});

// ─── fixture helpers ───

function stat(
  project: string,
  hook: string,
  ms: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ts: new Date().toISOString(), project, hook, ms, ...extra };
}

function writeStats(records: readonly Record<string, unknown>[]): void {
  mkdirSync(join(home(), '.state'), { recursive: true });
  writeFileSync(
    join(home(), '.state', 'stats.jsonl'),
    records.map(record => JSON.stringify(record)).join('\n') + '\n'
  );
}

/** A discoverable project: any directory under `projects/` holding an `inbox.md`. */
function seedProject(key: string): string {
  const dir = join(home(), 'projects', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inbox.md'), '# Inbox\n');
  return dir;
}
