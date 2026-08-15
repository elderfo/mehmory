/**
 * `mehmory doctor` — criterion 8. Each check is broken in turn and the specific finding
 * plus the exit code asserted, so a check that silently stops firing fails here.
 */

import { TEMPLATE_SCHEMA_VERSION } from '../src/core/store.js';
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { envelopeOf, fakeInstalledPlugin, runCli } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

interface Fixture {
  /** HOME whose `~/.claude` holds a complete plugin install. */
  readonly claudeHome: string;
  /** A stable cwd, so every run in one test resolves the same project key. */
  readonly cwd: string;
}

interface DoctorFinding {
  readonly check: string;
  readonly level: string;
  readonly message: string;
  readonly fix?: string;
}

/** A store where every check passes, so a test observes only the fault it introduces. */
function healthyStore(): Fixture {
  const cwd = createTempDir('mehmory-cli-cwd');
  expect(runCli(['init'], { cwd }).status).toBe(0);
  // A fresh store is uncommitted and has never seen a hook fire — both real warnings.
  execFileSync('git', ['-C', home(), 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', home(), 'commit', '--no-gpg-sign', '-m', 'init'], { stdio: 'pipe' });
  writeStats(statsForEveryHook());
  return { claudeHome: fakeInstalledPlugin(), cwd };
}

/** Findings of one doctor run, keyed by check id. */
function findings(fixture: Fixture): Map<string, DoctorFinding> {
  const run = runCli(['doctor', '--json'], fixture);
  const data = envelopeOf(run)['data'] as Record<string, unknown>;
  const list = data['findings'] as readonly DoctorFinding[];
  return new Map(list.map(f => [f.check, f]));
}

describe('mehmory doctor', () => {
  it('exits 0 with every check ok on a healthy store', () => {
    const fixture = healthyStore();
    const run = runCli(['doctor'], fixture);
    expect(run.stdout).not.toContain('[warn]');
    expect(run.stdout).not.toContain('[error]');
    expect(run.stdout).toContain('[ok] git.clean: working tree clean');
    expect(run.stdout).toContain('[ok] plugin:');
    expect(run.status).toBe(0);
  });

  it('reports an absent store as an error naming `mehmory init`, and exits 6', () => {
    const fixture: Fixture = { claudeHome: fakeInstalledPlugin(), cwd: createTempDir('cwd') };
    expect(runCli(['doctor'], fixture).status).toBe(6);
    expect(findings(fixture).get('store')).toMatchObject({ level: 'error', fix: 'mehmory init' });
  });

  it('warns when the store `.gitignore` is gone, and exits 5', () => {
    const fixture = healthyStore();
    rmSync(join(home(), '.gitignore'));
    const found = findings(fixture);
    expect(found.get('git.gitignore')).toMatchObject({ level: 'warn' });
    expect(found.get('git.gitignore')?.fix).toContain(`> ${join(home(), '.gitignore')}`);
    expect(runCli(['doctor'], fixture).status).toBe(5);
  });

  it('warns when the working tree is dirty', () => {
    const fixture = healthyStore();
    writeFileSync(join(home(), 'global', 'index.md'), '# Index\n\nedited\n');
    const found = findings(fixture);
    expect(found.get('git.clean')).toMatchObject({ level: 'warn' });
    expect(found.get('git.clean')?.fix).toContain(`git -C ${home()}`);
  });

  it('warns per disabled hook, naming the config key', () => {
    const fixture = healthyStore();
    writeFileSync(join(home(), 'config.json'), JSON.stringify({ hooks: { stop: { enabled: false } } }));
    const found = findings(fixture);
    expect(found.get('hooks.enabled.stop')).toMatchObject({ level: 'warn' });
    expect(found.get('hooks.enabled.stop')?.message).toContain('hooks.stop.enabled');
  });

  it('errors on an unparseable config.json, and exits 6', () => {
    const fixture = healthyStore();
    writeFileSync(join(home(), 'config.json'), '{ not json');
    expect(findings(fixture).get('config')).toMatchObject({ level: 'error' });
    expect(runCli(['doctor'], fixture).status).toBe(6);
  });

  it('warns on schema_version drift against the template constant, not FORMAT_VERSION', () => {
    const fixture = healthyStore();
    writeFileSync(join(home(), 'SCHEMA.md'), '---\nschema_version: "0"\n---\n\n# old\n');
    const found = findings(fixture);
    expect(found.get('schema_version')).toMatchObject({ level: 'warn' });
    expect(found.get('schema_version')?.message).toContain(`this build ships ${TEMPLATE_SCHEMA_VERSION}`);
  });

  it('warns when no hook has ever reported', () => {
    const fixture = healthyStore();
    rmSync(join(home(), '.state', 'stats.jsonl'));
    const found = findings(fixture);
    expect(found.get('hooks.liveness')).toMatchObject({
      level: 'warn',
      message: 'no hook has ever reported to stats.jsonl',
    });
    // No `fix`: the runnable remedy belongs to the plugin check, and U10 forbids
    // inventing a plausible-looking command to fill the clause.
    expect(found.get('hooks.liveness')?.fix).toBeUndefined();
  });

  it('warns on stale stats — hooks that used to report and stopped', () => {
    const fixture = healthyStore();
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    writeStats(statsForEveryHook().map(record => ({ ...record, ts: old })));
    expect(findings(fixture).get('hooks.silent')).toMatchObject({ level: 'warn' });
  });

  it('warns on a KPI budget violation, using the amended numbers', () => {
    const fixture = healthyStore();
    const ts = new Date().toISOString();
    writeStats([
      ...statsForEveryHook(),
      // 951 tokens: one over the amended combined budget of 950.
      { ts, project: 'p', hook: 'SessionStart', ms: 10, injected_tokens: 951 },
      { ts, project: 'p', hook: 'UserPromptSubmit', ms: 400 },
    ]);
    const found = findings(fixture);
    expect(found.get('kpi.injection')?.message).toContain('over the 950 combined budget');
    expect(found.get('kpi.UserPromptSubmit')?.message).toContain('over its 100 ms budget');
  });

  it('warns when the inbox has piled up, pointing at the integrate skill', () => {
    const fixture = healthyStore();
    const key = keyOf(fixture);
    const dir = join(home(), 'projects', key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'inbox.md'), inboxWith(12));

    const found = findings(fixture);
    expect(found.get('inbox')).toMatchObject({ level: 'warn' });
    expect(found.get('inbox')?.message).toContain('12 un-integrated inbox entries');
    expect(found.get('inbox')?.fix).toBe('in a Claude Code session, run `/mehmory:integrate`');
  });

  it('warns and prints a runnable tail command when errors.log has content', () => {
    const fixture = healthyStore();
    const path = join(home(), '.state', 'errors.log');
    writeFileSync(path, '[2026-07-30T00:00:00.000Z] E_GIT_COMMIT: boom\n');
    const found = findings(fixture);
    expect(found.get('errors')).toMatchObject({ level: 'warn' });
    expect(found.get('errors')?.fix).toBe(`tail -n 20 ${path}`);
  });

  it('errors when the installed plugin registers fewer than the five hooks', () => {
    const fixture = healthyStore();
    const partial: Fixture = { claudeHome: fakeInstalledPlugin(['SessionStart']), cwd: fixture.cwd };
    const found = findings(partial);
    expect(found.get('plugin')).toMatchObject({ level: 'error' });
    expect(found.get('plugin')?.message).toContain('UserPromptSubmit');
  });

  it('ends its text output with the single highest-priority remedy', () => {
    const fixture = healthyStore();
    writeFileSync(join(home(), 'config.json'), '{ not json');
    const run = runCli(['doctor'], fixture);
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe(`next: $EDITOR ${join(home(), 'config.json')}`);
  });
});

// ─── fixture helpers ───

function writeStats(records: readonly Record<string, unknown>[]): void {
  mkdirSync(join(home(), '.state'), { recursive: true });
  writeFileSync(
    join(home(), '.state', 'stats.jsonl'),
    records.map(record => JSON.stringify(record)).join('\n') + '\n'
  );
}

function statsForEveryHook(): Record<string, unknown>[] {
  const ts = new Date().toISOString();
  return ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd'].map(hook => ({
    ts,
    project: 'p',
    hook,
    ms: 5,
  }));
}

function inboxWith(count: number): string {
  const lines = Array.from(
    { length: count },
    (_unused, i) =>
      `- entry ${String(i)} <!--mehmory id=${String(i).padStart(16, '0')} src=s ts=2026-07-01T00:00:00.000Z-->`
  );
  return `# Inbox\n\n${lines.join('\n')}\n`;
}

/** The project key doctor resolves for a fixture's cwd, read back from its own output. */
function keyOf(fixture: Fixture): string {
  const message = findings(fixture).get('inbox')?.message ?? '';
  return /inbox entries for (\S+)/.exec(message)?.[1] ?? '';
}
