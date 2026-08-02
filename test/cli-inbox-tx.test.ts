/**
 * `mehmory inbox-tx` — issue #17: the transactional inbox helper reachable through the
 * CLI, with the same input contract as the bundled `hooks/inbox-tx.mjs` script that
 * `test/inbox-tx.test.ts` covers directly.
 *
 * Spawns the BUILT `dist/cli.mjs`, not the TypeScript source (the built-CLI seam), the
 * same way every other `test/cli-*.test.ts` suite does.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, hermeticEnv } from './helpers.js';
import { CLI, envelopeOf, type CliRun } from './cli-fixture.js';

/** `mehmory inbox-tx` with a JSON body piped to stdin — the CLI has no other way in. */
function tx(subcommand: string, input: unknown, extraArgs: readonly string[] = []): CliRun {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} is missing — run \`pnpm build\` before \`pnpm test\`.`);
  }
  const result = spawnSync(process.execPath, [CLI, 'inbox-tx', subcommand, ...extraArgs], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf-8',
    env: hermeticEnv({ HOME: createTempDir('mehmory-claude-home') }),
    cwd: process.env.MEHMORY_HOME,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function json(result: CliRun): unknown {
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

/** Every `host=` value stamped on the inbox's entry lines, in file order. */
function hostsIn(body: string): string[] {
  return [...body.matchAll(/host=(\S+)/g)].map(m => m[1] as string);
}

let inbox: string;
let key: string;

function seed(): void {
  const home = process.env.MEHMORY_HOME as string;
  mkdirSync(join(home, '.state'), { recursive: true });
  inbox = join(home, 'inbox.md');
  key = 'github.com/acme/widget';
  writeFileSync(inbox, '# Inbox\n');
}

describe('mehmory inbox-tx append', () => {
  it('appends redacted entries and dedups by id — same output shape as the bundled helper', () => {
    seed();
    const first = json(
      tx('append', {
        inbox,
        key,
        entries: [
          { text: 'chose pnpm over npm', src: 'sess-a' },
          { text: 'chose pnpm over npm', src: 'sess-a' },
        ],
      })
    );
    expect(first).toEqual({ appended: 1, skipped: 1 });

    const body = readFileSync(inbox, 'utf-8');
    expect(body.match(/mehmory id=/g)).toHaveLength(1);
  });

  it('redacts secrets before they reach the inbox', () => {
    seed();
    tx('append', {
      inbox,
      key,
      entries: [{ text: 'deploy key AKIAIOSFODNN7EXAMPLE is in the env', src: 'sess-a' }],
    });
    const body = readFileSync(inbox, 'utf-8');
    expect(body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(body).toContain('deploy key');
  });

  // `every`, not `some`: the failure mode is a well-formed line with the wrong
  // attribution, which `some` would sail straight past (F3-2, issue #20).
  it('stamps the declared host on every entry, so a Codex skill does not record claude-code', () => {
    seed();
    json(
      tx('append', {
        inbox,
        key,
        host: 'codex',
        entries: [
          { text: 'codex entry one', src: 'sess-cx' },
          { text: 'codex entry two', src: 'sess-cx' },
        ],
      })
    );
    const hosts = hostsIn(readFileSync(inbox, 'utf-8'));
    expect(hosts).toHaveLength(2);
    expect(hosts.every(h => h === 'codex')).toBe(true);
  });

  it('falls back to the host recorded in the src session state when none is declared', () => {
    seed();
    const home = process.env.MEHMORY_HOME as string;
    writeFileSync(
      join(home, '.state', 'sess-cx.json'),
      JSON.stringify({
        session_id: 'sess-cx',
        cursor: { file_id: '0:0', size: 0, offset: 0 },
        stop_count: 0,
        host: 'codex',
        paused: false,
      })
    );

    json(tx('append', { inbox, key, entries: [{ text: 'derived host', src: 'sess-cx' }] }));
    const hosts = hostsIn(readFileSync(inbox, 'utf-8'));
    expect(hosts).toHaveLength(1);
    expect(hosts.every(h => h === 'codex')).toBe(true);
  });

  it('rejects an unknown host rather than silently defaulting it', () => {
    seed();
    const result = tx('append', {
      inbox,
      key,
      host: 'emacs',
      entries: [{ text: 'unknown host', src: 'sess-a' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host');
  });
});

describe('mehmory inbox-tx snapshot/clear', () => {
  it('clears exactly the snapshotted entries, so a concurrent append survives', () => {
    seed();
    tx('append', {
      inbox,
      key,
      entries: [
        { text: 'entry one', src: 'sess-a' },
        { text: 'entry two', src: 'sess-a' },
      ],
    });

    const snap = json(tx('snapshot', { inbox, key })) as {
      snapshotId: string;
      entries: { text: string }[];
    };
    expect(snap.entries.map(e => e.text)).toEqual(['entry one', 'entry two']);

    tx('append', { inbox, key, entries: [{ text: 'entry three', src: 'sess-b' }] });

    const cleared = json(tx('clear', { inbox, key, snapshotId: snap.snapshotId }));
    expect(cleared).toEqual({ removed: 2 });

    const body = readFileSync(inbox, 'utf-8');
    expect(body).toContain('entry three');
    expect(body).not.toContain('entry one');
  });
});

describe('mehmory inbox-tx — CLI envelope and exit-code conventions', () => {
  it('exits 1 (E_USAGE) on bad stdin JSON, matching the CLI usage-error convention', () => {
    seed();
    const result = tx('append', 'this is not json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MEHMORY E_USAGE');
  });

  it('exits 1 on an unknown subcommand and on missing fields', () => {
    seed();
    expect(tx('destroy', { inbox, key }).status).toBe(1);
    expect(tx('append', { key, entries: [] }).stderr).toContain('inbox');
    expect(tx('clear', { inbox, key, snapshotId: 'nope' }).status).toBe(1);
  });

  it('missing subcommand is a usage error, not a crash', () => {
    seed();
    const result = spawnSync(process.execPath, [CLI, 'inbox-tx'], {
      input: '{}',
      encoding: 'utf-8',
      env: hermeticEnv({ HOME: createTempDir('mehmory-claude-home') }),
      cwd: process.env.MEHMORY_HOME,
    });
    expect(result.status).toBe(1);
  });

  it('--json emits the standard envelope with the append result as data', () => {
    seed();
    const result = tx(
      'append',
      { inbox, key, entries: [{ text: 'json envelope check', src: 'sess-a' }] },
      ['--json']
    );
    expect(result.status).toBe(0);
    const envelope = envelopeOf(result);
    expect(envelope['command']).toBe('inbox-tx');
    expect(envelope['ok']).toBe(true);
    expect(envelope['data']).toEqual({ appended: 1, skipped: 0 });
  });
});
