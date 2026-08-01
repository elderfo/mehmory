/**
 * Fixture harness for the hook suites: spawn a BUILT `hooks/*.mjs` with fixture stdin
 * and inspect what it wrote (criterion 3 — the tests exercise the artifact the plugin
 * actually runs, not the TypeScript source).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, hermeticEnv } from './helpers.js';
import { mehmoryHome, statePath } from '../src/core/home.js';
import { resolveProjectKey } from '../src/core/identity.js';
import { initStore } from '../src/core/store.js';
import { serializeInboxEntry, inboxEntryId } from '../src/schema/format.js';

/** The five hook bundles, by the name of their `.mjs` file. */
export type HookName =
  | 'session-start'
  | 'user-prompt-submit'
  | 'stop'
  | 'pre-compact'
  | 'session-end';

/** Directory the build writes bundles to (repo root is vitest's cwd). */
export const HOOKS_DIR = join(process.cwd(), 'hooks');

/** Result of one hook invocation. */
export interface HookRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn a built hook bundle with `input` as its stdin JSON. Never throws.
 *
 * `args` are extra command-line arguments, e.g. the host argument `hooks.json` passes
 * on every command (`["claude-code"]`) — omit it to exercise the no-argument fallback.
 */
export function runHook(
  hook: HookName,
  input: Record<string, unknown>,
  options: { cwd?: string; args?: readonly string[] } = {}
): HookRun {
  const script = join(HOOKS_DIR, `${hook}.mjs`);
  if (!existsSync(script)) {
    throw new Error(`${script} is missing — run \`pnpm build\` before the hook suites.`);
  }
  const result = spawnSync(process.execPath, [script, ...(options.args ?? [])], {
    input: JSON.stringify(input),
    env: hermeticEnv(),
    encoding: 'utf-8',
    cwd: options.cwd ?? createTempDir('mehmory-hook-cwd'),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The `additionalContext` a hook emitted, or '' when it stayed silent. */
export function additionalContext(run: HookRun): string {
  if (!run.stdout.trim()) return '';
  const parsed: unknown = JSON.parse(run.stdout);
  const output = (parsed as Record<string, unknown>)['hookSpecificOutput'];
  if (typeof output !== 'object' || output === null) return '';
  const context = (output as Record<string, unknown>)['additionalContext'];
  return typeof context === 'string' ? context : '';
}

/** A hook's raw stdout object (Stop's `{decision, reason}`). */
export function outputJson(run: HookRun): Record<string, unknown> {
  if (!run.stdout.trim()) return {};
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

/** The project key a hook invoked with `cwd` will resolve. */
export function keyFor(cwd: string): string {
  return resolveProjectKey(cwd);
}

/** A scope's file paths inside the temp store. */
export function paths(key: string): {
  projectDir: string;
  inbox: string;
  log: string;
  pages: string;
  index: string;
} {
  const projectDir = join(mehmoryHome(), 'projects', key);
  return {
    projectDir,
    inbox: join(projectDir, 'inbox.md'),
    log: join(projectDir, 'log.md'),
    pages: join(projectDir, 'pages'),
    index: join(projectDir, 'index.md'),
  };
}

/** Options for `seedStore`. */
export interface SeedOptions {
  /** `pages/<name>` → contents. */
  readonly pages?: Record<string, string>;
  /** Contents of `project.md`. */
  readonly project?: string;
  /** Contents of `index.md`. */
  readonly index?: string;
  /** Number of synthetic inbox entries to pre-append. */
  readonly inboxEntries?: number;
}

/** Initialize the temp store and populate one project scope. */
export function seedStore(key: string, options: SeedOptions = {}): void {
  initStore();
  const scope = paths(key);
  mkdirSync(scope.pages, { recursive: true });

  writeFileSync(
    join(scope.projectDir, 'project.md'),
    options.project ?? '---\nupdated: 2026-07-01\ntype: entity\n---\n\n# Project\n\n- stack: typescript\n'
  );
  writeFileSync(
    scope.index,
    options.index ?? '---\nupdated: 2026-07-01\ntype: entity\n---\n\n# Index\n'
  );
  for (const [name, body] of Object.entries(options.pages ?? {})) {
    writeFileSync(join(scope.pages, name), body);
  }

  if (options.inboxEntries) {
    const lines = Array.from({ length: options.inboxEntries }, (_, i) =>
      serializeInboxEntry({
        id: inboxEntryId(`seed-${String(i)}`),
        text: `seeded entry ${String(i)}`,
        src: 'seed-session',
        ts: '2026-07-01T00:00:00.000Z',
      })
    );
    writeFileSync(scope.inbox, `# Inbox\n\n${lines.join('\n')}\n`);
  }
}

/** Write a transcript JSONL file and return its path. */
export function writeTranscript(
  records: readonly Record<string, unknown>[],
  sessionId = 'session-a'
): string {
  const dir = createTempDir('mehmory-transcript');
  const path = join(dir, 'transcript.jsonl');
  const lines = records.map((record, i) =>
    JSON.stringify({
      type: 'message',
      role: 'user',
      sessionId,
      uuid: `uuid-${sessionId}-${String(i)}`,
      ...record,
    })
  );
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/** Contents of the store's errors.log ('' when nothing was logged). */
export function errorsLog(): string {
  const path = statePath('errors.log');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** Every stats.jsonl record written so far. */
export function statsLines(): Record<string, unknown>[] {
  const path = statePath('stats.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/** Contents of a file, or '' when it does not exist. */
export function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}
