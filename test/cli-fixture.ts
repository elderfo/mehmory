/**
 * Harness for the CLI suites: spawn the **built** `dist/cli.mjs` as a subprocess, the
 * way a user's shell does (criterion 2), against a temp store and a temp fake `~/.claude`.
 *
 * Never `process.env` directly — `hermeticEnv()` is what stops a child inheriting the
 * developer's real `~/.mehmory` or `~/.claude`, and the in-process guard in `setup.ts`
 * cannot see a child (criterion 20).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { createTempDir, hermeticEnv } from './helpers.js';
import { HOOK_EVENTS } from '../src/core/environment.js';

/** The artifact under test. Vitest's cwd is the repo root. */
export const CLI = join(process.cwd(), 'dist', 'cli.mjs');

export interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  /** Working directory, which is what `resolveProjectKey` reads. */
  readonly cwd?: string;
  /** HOME for the child, i.e. where `~/.claude` is looked for. */
  readonly claudeHome?: string;
  /** MEHMORY_HOME override, for the fixtures that need a broken store path. */
  readonly mehmoryHome?: string;
}

/** Run the CLI once. Throws only if the build is missing. */
export function runCli(args: readonly string[], options: CliOptions = {}): CliRun {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} is missing — run \`pnpm build\` before the CLI suites.`);
  }
  const env = hermeticEnv({
    HOME: options.claudeHome ?? createTempDir('mehmory-claude-home'),
    ...(options.mehmoryHome !== undefined ? { MEHMORY_HOME: options.mehmoryHome } : {}),
  });
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf-8',
    cwd: options.cwd ?? createTempDir('mehmory-cli-cwd'),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The parsed `--json` envelope. Fails loudly when stdout is not exactly one line. */
export function envelopeOf(run: CliRun): Record<string, unknown> {
  const lines = run.stdout.split('\n').filter(line => line !== '');
  if (lines.length !== 1) {
    throw new Error(`expected exactly one stdout line, got ${String(lines.length)}: ${run.stdout}`);
  }
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

/**
 * A fake `~/.claude` in which the mehmory plugin is installed, with a `hooks.json` that
 * registers `events`. Returns the HOME to pass as `claudeHome`.
 */
export function fakeInstalledPlugin(
  events: readonly string[] = Object.values(HOOK_EVENTS),
  /** Install into an existing fake HOME (e.g. one that already holds transcripts). */
  into?: string
): string {
  const home = into ?? createTempDir('mehmory-claude-home');
  const installPath = join(home, '.claude', 'plugins', 'cache', 'mehmory', 'mehmory', '0.0.1');
  mkdirSync(join(installPath, 'hooks'), { recursive: true });
  writeFileSync(
    join(installPath, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, []])) })
  );
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'mehmory@mehmory': [{ scope: 'user', installPath, version: '0.0.1' }] },
    })
  );
  return home;
}

/**
 * A content hash of every file under `dir`, excluding `.git` (which records its own
 * timestamps) — the instrument criterion 4's "running it twice changes nothing" uses.
 */
export function treeDigest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.git') continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        hash.update(`d:${relative(dir, path)}\n`);
        walk(path);
      } else {
        hash.update(`f:${relative(dir, path)}:`);
        hash.update(readFileSync(path));
        hash.update('\n');
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}
