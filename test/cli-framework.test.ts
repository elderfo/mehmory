/**
 * CLI framework: exit codes (criterion 2) and the `--json` envelope (criterion 3).
 *
 * Every case here spawns the built bundle, so what is asserted is the artifact a user
 * runs — not a TypeScript function that happens to return the same number.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { CLI_JSON_SCHEMA } from '../src/cli/envelope.js';
import { CLI, envelopeOf, fakeInstalledPlugin, runCli } from './cli-fixture.js';

/** A store the read commands are happy with. */
function initStore(): void {
  const run = runCli(['init']);
  expect(run.status).toBe(0);
}

describe('help and version', () => {
  it('exits 0 for `--help` and lists every registered command', () => {
    const run = runCli(['--help']);
    expect(run.status).toBe(0);
    for (const name of ['init', 'doctor', 'status', 'stats', 'search', 'onboard', 'purge']) {
      expect(run.stdout).toContain(name);
    }
  });

  it('exits 0 for `<cmd> --help` and prints that command’s documented flags', () => {
    const run = runCli(['stats', '--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('mehmory stats [--project [<key>]|--global|--agent [<name>]|--all] [--since <iso>] [--json]');
    expect(run.stdout).toContain('--since <iso>');
  });

  it('exits 0 for `--version` and prints the package.json version', () => {
    const run = runCli(['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints the stub commands’ documented flags in their help', () => {
    expect(runCli(['search', '--help']).stdout).toContain('--limit N');
    expect(runCli(['onboard', '--help']).stdout).toContain('--max-bytes N');
    expect(runCli(['purge', '--help']).stdout).toContain('--export <path>');
  });
});

describe('exit 1 — usage errors', () => {
  it('prints usage to stderr and exits 1 for an unknown command', () => {
    const run = runCli(['nope']);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown command `nope`');
    expect(run.stderr).toContain('Usage: mehmory <command>');
  });

  it('exits 1 when flags are given with no command at all', () => {
    const run = runCli(['--json']);
    expect(run.status).toBe(1);
    const errors = envelopeOf(run)['errors'] as readonly Record<string, unknown>[];
    expect(errors[0]?.['what']).toContain('no command given');
  });

  it('exits 1 for an unknown flag on a known command', () => {
    const run = runCli(['status', '--bogus']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown flag `--bogus`');
  });

  it('exits 1 for bad arity', () => {
    const run = runCli(['status', 'extra-arg']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('takes no arguments');
  });

  it('exits 1 for a flag that is missing its required value', () => {
    initStore();
    const run = runCli(['stats', '--since']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('`--since` requires a value');
  });

  it('exits 1 with the candidate list for an ambiguous selector', () => {
    initStore();
    for (const key of ['github.com/acme/widgets', 'github.com/acme/widgets-api']) {
      const dir = join(process.env.MEHMORY_HOME ?? '', 'projects', key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'inbox.md'), '# Inbox\n');
    }
    const run = runCli(['stats', '--project', 'widgets']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('github.com/acme/widgets');
    expect(run.stderr).toContain('github.com/acme/widgets-api');
  });
});

describe('exit 2 — store missing where required', () => {
  it('exits 2 for `status` with no store', () => {
    const run = runCli(['status']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Fix: mehmory init');
  });

  it('exits 2 for `stats` with no store', () => {
    expect(runCli(['stats']).status).toBe(2);
  });

  it('never exits 2 from `doctor` — a missing store is its finding, not its failure', () => {
    const run = runCli(['doctor']);
    expect(run.status).toBe(6);
    expect(run.stdout).toContain('no mehmory store at');
    expect(run.stdout).toContain('fix: mehmory init');
  });
});

describe('exit 3 — operation failed', () => {
  it('exits 3 when the store path cannot be created', () => {
    // A regular file where the store's parent directory should be: `mkdir` fails with
    // ENOTDIR, which is `initStore` reporting a real write failure rather than a
    // usage mistake.
    const blocker = join(createTempDir('mehmory-blocked'), 'not-a-dir');
    writeFileSync(blocker, 'file, not a directory\n');
    const run = runCli(['init'], { mehmoryHome: join(blocker, 'store') });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('MEHMORY E_STORE_INIT');
  });
});

describe('exit codes 5 and 6 — doctor only', () => {
  it('exits 5 when only warnings fire', () => {
    initStore();
    // A fresh store has no commits, which is a warning; the plugin check is the only
    // error source, so a fake install removes it.
    const run = runCli(['doctor'], { claudeHome: pluginHome() });
    expect(run.status).toBe(5);
    expect(run.stdout).not.toContain('[error]');
    expect(run.stdout).toContain('[warn]');
  });

  it('exits 6 when any error-level finding fires', () => {
    initStore();
    const run = runCli(['doctor']);
    expect(run.status).toBe(6);
    expect(run.stdout).toContain('[error] plugin');
  });
});

describe('the --json envelope', () => {
  it('emits exactly one line on the success path', () => {
    initStore();
    const run = runCli(['status', '--json']);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const envelope = envelopeOf(run);
    expect(envelope['schema']).toBe(CLI_JSON_SCHEMA);
    expect(envelope['command']).toBe('status');
    expect(envelope['ok']).toBe(true);
    expect(envelope['errors']).toEqual([]);
    expect(envelope['data']).toMatchObject({ scope: 'project' });
  });

  it('emits the envelope on a failure path with ok:false and a typed error', () => {
    const run = runCli(['status', '--json']);
    expect(run.status).toBe(2);
    expect(run.stderr).toBe('');
    const envelope = envelopeOf(run);
    expect(envelope['ok']).toBe(false);
    expect(envelope['errors']).toEqual([
      {
        code: 'E_STORE_INIT',
        what: 'no mehmory store found',
        consequence: '`mehmory status` has nothing to read',
        fix: 'mehmory init',
      },
    ]);
  });

  it('emits the envelope for a usage error found before any command runs', () => {
    // The whole point of criterion 3: a pre-command parse failure must not be the one
    // path that answers in a different shape.
    const run = runCli(['nope', '--json']);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
    const envelope = envelopeOf(run);
    expect(envelope['ok']).toBe(false);
    const errors = envelope['errors'] as readonly Record<string, unknown>[];
    expect(errors[0]?.['code']).toBe('E_USAGE');
    expect(errors[0]?.['fix']).toBe('mehmory --help');
  });

  it('carries the `{code, what, consequence, fix}` shape and no `Details:` path', () => {
    const run = runCli(['status', '--bogus', '--json']);
    const errors = envelopeOf(run)['errors'] as readonly Record<string, unknown>[];
    expect(Object.keys(errors[0] ?? {}).sort()).toEqual(['code', 'consequence', 'fix', 'what']);
    expect(JSON.stringify(errors)).not.toContain('Details:');
  });
});

describe('packaging', () => {
  it('is one ESM bundle with a shebang and no relative imports left to resolve', () => {
    const source = readFileSync(CLI, 'utf-8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    // `splitting: false` plus `noExternal` means nothing is imported at runtime; a
    // leftover relative import would break the moment npm installs this outside the repo.
    expect(source).not.toMatch(/^import .* from ["']\.\.?\//m);
  });
});

/** HOME whose `~/.claude` has the plugin installed with all five hooks registered. */
function pluginHome(): string {
  return fakeInstalledPlugin();
}
