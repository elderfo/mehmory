/**
 * Direct tests for the bundled `hooks/inbox-tx.mjs` transactional helper (criterion 17).
 *
 * These spawn the BUILT artifact, not the TypeScript source: the contract skills rely on
 * is "node hooks/inbox-tx.mjs <subcommand>" resolving with no node_modules present, and
 * only the bundle proves that.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hermeticEnv } from './helpers.js';

const HELPER = resolve('hooks/inbox-tx.mjs');

interface TxResult {
  status: number;
  stdout: string;
  stderr: string;
}

function tx(subcommand: string, input: unknown): TxResult {
  if (!existsSync(HELPER)) {
    throw new Error(`${HELPER} is missing — run \`pnpm build\` before \`pnpm test\`.`);
  }
  const run = spawnSync(process.execPath, [HELPER, subcommand], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf-8',
    env: hermeticEnv(),
    // Outside the repo: a bundle that still needs node_modules fails here.
    cwd: process.env.MEHMORY_HOME,
  });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

/** Assert a successful run and return its parsed stdout. */
function json(result: TxResult): unknown {
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

let inbox: string;
let key: string;

beforeEach(() => {
  const home = process.env.MEHMORY_HOME as string;
  mkdirSync(join(home, '.state'), { recursive: true });
  inbox = join(home, 'inbox.md');
  key = 'github.com/acme/widget';
  writeFileSync(inbox, '# Inbox\n');
});

describe('inbox-tx append', () => {
  it('appends redacted entries and dedups by id', () => {
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

    // Same text + src on a later invocation is still a replay no-op.
    const second = json(
      tx('append', { inbox, key, entries: [{ text: 'chose pnpm over npm', src: 'sess-a' }] })
    );
    expect(second).toEqual({ appended: 0, skipped: 1 });

    const body = readFileSync(inbox, 'utf-8');
    expect(body.match(/mehmory id=/g)).toHaveLength(1);
    expect(body).toContain('# Inbox');
  });

  it('redacts secrets before they reach the inbox', () => {
    tx('append', {
      inbox,
      key,
      entries: [{ text: 'deploy key AKIAIOSFODNN7EXAMPLE is in the env', src: 'sess-a' }],
    });
    const body = readFileSync(inbox, 'utf-8');
    expect(body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(body).toContain('deploy key');
  });
});

describe('inbox-tx snapshot/clear', () => {
  it('clears exactly the snapshotted entries, so a concurrent append survives', () => {
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
    expect(existsSync(join(process.env.MEHMORY_HOME as string, '.state', `inbox-snapshot.${snap.snapshotId}.json`))).toBe(true);

    // Racing capture between snapshot and clear — the whole reason this is not a raw Edit.
    tx('append', { inbox, key, entries: [{ text: 'entry three', src: 'sess-b' }] });

    const cleared = json(
      tx('clear', { inbox, key, snapshotId: snap.snapshotId })
    );
    expect(cleared).toEqual({ removed: 2 });

    const body = readFileSync(inbox, 'utf-8');
    expect(body).toContain('entry three');
    expect(body).not.toContain('entry one');
    expect(body).not.toContain('entry two');

    // Snapshot file is consumed, so a replayed clear cannot remove the survivor.
    const replay = tx('clear', { inbox, key, snapshotId: snap.snapshotId });
    expect(replay.status).toBe(1);
    expect(readFileSync(inbox, 'utf-8')).toContain('entry three');
  });
});

describe('inbox-tx failure paths', () => {
  it('exits 1 with one stderr line and leaves the inbox untouched on bad JSON', () => {
    tx('append', { inbox, key, entries: [{ text: 'survivor', src: 'sess-a' }] });
    const before = readFileSync(inbox, 'utf-8');

    const result = tx('append', 'this is not json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(/^inbox-tx: /);
    expect(readFileSync(inbox, 'utf-8')).toBe(before);
  });

  it('exits 1 on an unknown subcommand and on missing fields', () => {
    expect(tx('destroy', { inbox, key }).status).toBe(1);
    expect(tx('append', { key, entries: [] }).stderr).toContain('inbox');
    expect(tx('clear', { inbox, key, snapshotId: 'nope' }).status).toBe(1);
  });
});
