/**
 * `mehmory search` — criterion 6.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { envelopeOf, runCli } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

/** A discoverable project with a `pages/` dir ready to hold fixture pages. */
function seedProject(key: string): { dir: string; pagesDir: string } {
  const dir = join(home(), 'projects', key);
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(dir, 'inbox.md'), '# Inbox\n');
  return { dir, pagesDir };
}

describe('mehmory search', () => {
  it('exits 2 when there is no store', () => {
    expect(runCli(['search', 'anything']).status).toBe(2);
  });

  it('requires exactly one query argument', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const run = runCli(['search'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('takes exactly one query argument');
  });

  it('ranks a page where the term is meaningful above one where it merely appears', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const key = String(
      (envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>)['key']
    );
    const { pagesDir } = seedProject(key);
    writeFileSync(
      join(pagesDir, 'aardvark.md'),
      '# Unrelated notes\n\nDeployment is mentioned exactly once in passing here.\n' +
        'Filler line one.\nFiller line two.\n'
    );
    writeFileSync(
      join(pagesDir, 'zephyr.md'),
      '# Deployment runbook\n\nDeployment steps: deployment starts, deployment checks, ' +
        'deployment finishes.\n'
    );

    const data = envelopeOf(runCli(['search', 'deployment', '--json'], { cwd }))['data'] as Record<
      string,
      unknown
    >;
    const hits = data['hits'] as { path: string; score: number }[];
    expect(hits.map(h => h.path)).toEqual(['pages/zephyr.md', 'pages/aardvark.md']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('reaches a hit in log.md', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const key = String(
      (envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>)['key']
    );
    const { dir } = seedProject(key);
    writeFileSync(
      join(dir, 'log.md'),
      '# Log\n\n## 2026-07-01T00:00:00.000Z integrate | rotated the staging credential\n'
    );

    const data = envelopeOf(runCli(['search', 'credential', '--json'], { cwd }))['data'] as Record<
      string,
      unknown
    >;
    const hits = data['hits'] as { path: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('log.md');
  });

  it('an empty result set exits 0 with a well-formed envelope', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const run = runCli(['search', 'nonexistentterm', '--json'], { cwd });
    expect(run.status).toBe(0);
    const envelope = envelopeOf(run);
    expect(envelope['ok']).toBe(true);
    expect((envelope['data'] as Record<string, unknown>)['hits']).toEqual([]);
  });

  it('`--limit` genuinely truncates and warns', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const key = String(
      (envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>)['key']
    );
    const { pagesDir } = seedProject(key);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(pagesDir, `widget-${String(i)}.md`), `# Widget ${String(i)}\n\nwidget notes\n`);
    }

    const run = runCli(['search', 'widget', '--limit', '2', '--json'], { cwd });
    const envelope = envelopeOf(run);
    const data = envelope['data'] as Record<string, unknown>;
    expect((data['hits'] as unknown[]).length).toBe(2);
    expect(envelope['warnings']).toEqual(
      expect.arrayContaining([expect.stringContaining('top 2 of 5 hits')])
    );
  });

  it('`--limit` caps at 100 even when a larger value is requested', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const data = envelopeOf(runCli(['search', 'x', '--limit', '500', '--json'], { cwd }))[
      'data'
    ] as Record<string, unknown>;
    expect(data['limit']).toBe(100);
  });

  it('`--all` spans every project plus global', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const { pagesDir: pagesA } = seedProject('github.com/acme/widgets');
    writeFileSync(join(pagesA, 'notes.md'), '# Notes\n\nkumquat sighting\n');
    mkdirSync(join(home(), 'global', 'pages'), { recursive: true });
    writeFileSync(join(home(), 'global', 'pages', 'g.md'), '# Global\n\nkumquat reference\n');

    const data = envelopeOf(runCli(['search', 'kumquat', '--all', '--json'], { cwd }))[
      'data'
    ] as Record<string, unknown>;
    const scopes = (data['hits'] as { scope: string }[]).map(h => h.scope).sort();
    expect(scopes).toEqual(['github.com/acme/widgets', 'global']);
  });
});
