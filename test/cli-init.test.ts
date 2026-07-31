/** `mehmory init` — criterion 4. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envelopeOf, fakeInstalledPlugin, runCli, treeDigest } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

describe('mehmory init', () => {
  it('creates the store `initStore()` owns and reports it', () => {
    const run = runCli(['init']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`store ready at ${home()}`);

    for (const path of ['global/identity.md', 'global/index.md', 'projects', 'SCHEMA.md', '.git']) {
      expect(existsSync(join(home(), path)), path).toBe(true);
    }
    // Written by `initStore()` (A6), not re-written here: `.gitignore` holds `.state/`
    // and `config.json` is empty, never a materialized copy of every default.
    expect(readFileSync(join(home(), '.gitignore'), 'utf-8')).toContain('.state/');
    expect(readFileSync(join(home(), 'config.json'), 'utf-8').trim()).toBe('{}');
  });

  it('is idempotent — a second run changes not one byte of the store tree', () => {
    expect(runCli(['init']).status).toBe(0);
    const before = treeDigest(home());
    expect(runCli(['init']).status).toBe(0);
    expect(treeDigest(home())).toBe(before);
  });

  it('checks the running Node against `engines`', () => {
    const run = runCli(['init', '--json']);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    const node = data['node'] as Record<string, unknown>;
    expect(node['required']).toBe('>=22');
    expect(node['current']).toBe(process.version);
    expect(node['ok']).toBe(true);
  });

  it('prints the pinned install commands when the plugin is absent', () => {
    const run = runCli(['init']);
    expect(run.stdout).toContain('plugin not installed');
    expect(run.stderr).toContain('/plugin marketplace add elderfo/mehmory');
    expect(run.stderr).toContain('/plugin install mehmory@mehmory');
    // U13: `init` runs in a shell, where a slash command does nothing.
    expect(run.stderr).toContain('in a Claude Code session, run');
  });

  it('finds the plugin by filesystem probe when it really is installed', () => {
    const run = runCli(['init', '--json'], { claudeHome: fakeInstalledPlugin() });
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect((data['plugin'] as Record<string, unknown>)['installed']).toBe(true);
    expect(envelopeOf(run)['warnings']).toEqual([]);
  });

  it('reports not-installed when the registry points at a directory with no hooks.json', () => {
    // The reason the probe is a filesystem check and not a manifest read: a stale
    // registry entry means no hook will ever fire, and a manifest read would call
    // that healthy.
    const claudeHome = fakeInstalledPlugin();
    const registry = join(claudeHome, '.claude', 'plugins', 'installed_plugins.json');
    const parsed = JSON.parse(readFileSync(registry, 'utf-8')) as {
      plugins: Record<string, { installPath: string }[]>;
    };
    const entry = parsed.plugins['mehmory@mehmory']?.[0];
    if (entry) entry.installPath = join(claudeHome, 'gone');
    writeFileSync(registry, JSON.stringify(parsed));

    const run = runCli(['init', '--json'], { claudeHome });
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect((data['plugin'] as Record<string, unknown>)['installed']).toBe(false);
  });

  it('ends with the next step, prefixed for the shell reader', () => {
    const lines = runCli(['init']).stdout.trimEnd().split('\n');
    expect(lines.at(-2)).toBe('next: mehmory onboard');
    expect(lines.at(-1)).toBe('then: in a Claude Code session, run `/mehmory:integrate`');
  });
});
