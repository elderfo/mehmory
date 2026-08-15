/**
 * `mehmory search` — criterion 6.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { envelopeOf, runCli } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

/** An agent scope: `identity.md` is what makes the directory one (KTD4). */
function seedAgent(name: string): string {
  const pagesDir = join(home(), 'agents', name, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(home(), 'agents', name, 'identity.md'), `# ${name}\n`);
  return pagesDir;
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(home(), 'config.json'), JSON.stringify(config));
}

/** The `scope` label of every hit an invocation returned, sorted. */
function hitScopes(args: readonly string[], cwd: string): string[] {
  const data = envelopeOf(runCli([...args, '--json'], { cwd }))['data'] as Record<string, unknown>;
  return (data['hits'] as { scope: string }[]).map(h => h.scope).sort();
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

  it('`--all` spans agent scopes too, labelled apart from project keys', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const { pagesDir } = seedProject('github.com/acme/widgets');
    writeFileSync(join(pagesDir, 'notes.md'), '# Notes\n\nkumquat sighting\n');
    mkdirSync(join(home(), 'global', 'pages'), { recursive: true });
    writeFileSync(join(home(), 'global', 'pages', 'g.md'), '# Global\n\nkumquat reference\n');
    writeFileSync(join(seedAgent('scout'), 'self.md'), '# Self\n\nkumquat preference\n');

    expect(hitScopes(['search', 'kumquat', '--all'], cwd)).toEqual([
      'agent:scout',
      'github.com/acme/widgets',
      'global',
    ]);
  });

  it('`--agent <name>` resolves to that agent scope and nothing else', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const { pagesDir } = seedProject('github.com/acme/widgets');
    writeFileSync(join(pagesDir, 'notes.md'), '# Notes\n\nkumquat sighting\n');
    writeFileSync(join(seedAgent('scout'), 'self.md'), '# Self\n\nkumquat preference\n');

    expect(hitScopes(['search', 'kumquat', '--agent', 'scout'], cwd)).toEqual(['agent:scout']);
  });

  it('`--agent` with an unknown name reports no match rather than creating one', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    seedAgent('scout');

    const run = runCli(['search', 'kumquat', '--agent', 'ghost'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no agent scope matches `ghost`');
    expect(existsSync(join(home(), 'agents', 'ghost'))).toBe(false);
  });

  it('bare `--agent` resolves the current session’s name from config', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    writeFileSync(join(seedAgent('scout'), 'self.md'), '# Self\n\nkumquat preference\n');
    writeConfig({ identity: { agent: 'scout' } });

    expect(hitScopes(['search', 'kumquat', '--agent'], cwd)).toEqual(['agent:scout']);
  });

  it('bare `--agent` resolves MEHMORY_AGENT ahead of config', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    writeFileSync(join(seedAgent('probe'), 'self.md'), '# Self\n\nkumquat preference\n');
    seedAgent('scout');
    writeConfig({ identity: { agent: 'scout' } });

    process.env['MEHMORY_AGENT'] = 'probe';
    try {
      expect(hitScopes(['search', 'kumquat', '--agent'], cwd)).toEqual(['agent:probe']);
    } finally {
      delete process.env['MEHMORY_AGENT'];
    }
  });

  it('bare `--agent` is a usage error when no name resolves', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    seedAgent('scout');

    const run = runCli(['search', 'kumquat', '--agent'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('bare `--agent` needs a named agent');
  });

  it('rejects `--agent` combined with `--project` or `--global`', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    seedAgent('scout');

    for (const other of ['--project', '--global']) {
      const run = runCli(['search', 'kumquat', '--agent', 'scout', other], { cwd });
      expect(run.status, other).toBe(1);
      expect(run.stderr, other).toContain('cannot be combined');
    }
  });

  it('keeps the two namespaces apart when a name is a substring of a key', () => {
    // KTD4: the flag separates the namespaces, not the key shape. `--project scout`
    // still resolves the project by substring; `--agent scout` never sees it.
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    const { pagesDir } = seedProject('github.com/acme/scout');
    writeFileSync(join(pagesDir, 'notes.md'), '# Notes\n\nkumquat sighting\n');
    writeFileSync(join(seedAgent('scout'), 'self.md'), '# Self\n\nkumquat preference\n');

    expect(hitScopes(['search', 'kumquat', '--agent', 'scout'], cwd)).toEqual(['agent:scout']);
    expect(hitScopes(['search', 'kumquat', '--project', 'scout'], cwd)).toEqual([
      'github.com/acme/scout',
    ]);
  });

  it('`--agent` never resolves a project key, even a full one', () => {
    const cwd = createTempDir('mehmory-cli-cwd');
    expect(runCli(['init'], { cwd }).status).toBe(0);
    seedProject('github.com/acme/scout');

    const run = runCli(['search', 'kumquat', '--agent', 'github.com/acme/scout'], { cwd });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no agent scope matches');
  });
});
