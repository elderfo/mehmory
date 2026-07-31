/**
 * `mehmory purge` — criterion 11, plus criterion 20's purge half.
 *
 * This is the only destructive command in the product and the only path to exit 4, so
 * every branch below asserts what is left on disk, not just the status code.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, hermeticEnv } from './helpers.js';
import { CLI, envelopeOf, runCli, treeDigest, type CliRun } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

/**
 * `runCli` with a confirmation token on stdin. Without `--yes` the token is read from
 * fd 0 (see the command's header), and `runCli` has no way to write it.
 */
function runCliTyped(args: readonly string[], token: string, cwd?: string): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: hermeticEnv({ HOME: createTempDir('mehmory-claude-home') }),
    encoding: 'utf-8',
    cwd: cwd ?? createTempDir('mehmory-cli-cwd'),
    input: token + '\n',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function write(relative: string, contents: string): string {
  const path = join(home(), relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

const KEY = 'github.com/acme/widgets';

/** A store with one nested project, one page in each scope, and two inbox entries. */
function seedStore(): void {
  expect(runCli(['init']).status).toBe(0);
  write(`projects/${KEY}/inbox.md`, '');
  write(`projects/${KEY}/pages/deploy.md`, '# deploy\n');
  write(`projects/${KEY}/pages/shared.md`, '# shared (project)\n');
  write('global/pages/shared.md', '# shared (global)\n');
  write(
    `projects/${KEY}/inbox.md`,
    '- keep this one <!--mehmory id=00000000000000a1 src=session-keep ts=2026-07-30T10:00:00Z-->\n' +
      '- purge this one <!--mehmory id=00000000000000a2 src=8f4c2b91-dead-beef-0000-1234abcd5678 ts=2026-07-30T10:00:00Z-->\n'
  );
}

describe('mehmory purge', () => {
  it('exits 4 and changes nothing when the typed token is wrong', () => {
    seedStore();
    const before = treeDigest(home());
    const run = runCliTyped(['purge', '--all'], 'delete all');

    expect(run.status).toBe(4);
    expect(run.stderr).toContain('is not the confirmation token');
    expect(treeDigest(home())).toBe(before);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(true);
  });

  it('exits 4 with the preview and the required token when none is typed', () => {
    seedStore();
    const before = treeDigest(home());
    const run = runCli(['purge', '--all']);

    expect(run.status).toBe(4);
    expect(run.stdout).toContain('purge    all memory in ' + home());
    expect(run.stderr).toContain("printf '%s\\n' 'DELETE ALL' | mehmory purge --all");
    expect(treeDigest(home())).toBe(before);
  });

  it('--all deletes every scope once `DELETE ALL` is typed, and commits', () => {
    seedStore();
    const run = runCliTyped(['purge', '--all'], 'DELETE ALL');
    expect(run.status).toBe(0);
    expect(existsSync(join(home(), 'projects'))).toBe(false);
    expect(existsSync(join(home(), 'global'))).toBe(false);
    // The repo itself is never touched — that is where the history A19 preserves lives.
    expect(existsSync(join(home(), '.git'))).toBe(true);
    expect(run.stdout).toContain('committed the removal');
  });

  it('says in its own output that git history retains the content, with the recipe', () => {
    seedStore();
    const run = runCliTyped(['purge', '--all'], 'DELETE ALL');
    expect(run.stdout).toContain('never');
    expect(run.stdout).toContain('rewrites your git history');
    expect(run.stdout).toContain(`git -C ${home()} filter-repo --path global --path projects --invert-paths`);
  });

  it('pins the project token to the resolved key, not the substring typed', () => {
    seedStore();
    // `widget` resolves to `github.com/acme/widgets`; confirming with what was typed
    // must not be enough.
    const wrong = runCliTyped(['purge', '--project', 'widget'], 'widget');
    expect(wrong.status).toBe(4);
    expect(existsSync(join(home(), 'projects', KEY))).toBe(true);

    const right = runCliTyped(['purge', '--project', 'widget'], KEY);
    expect(right.status).toBe(0);
    expect(existsSync(join(home(), 'projects', KEY))).toBe(false);
  });

  it('prunes the empty parents a nested key leaves behind', () => {
    seedStore();
    expect(runCliTyped(['purge', '--project', 'widget'], KEY).status).toBe(0);
    expect(existsSync(join(home(), 'projects', 'github.com'))).toBe(false);
    expect(existsSync(join(home(), 'projects'))).toBe(true);
  });

  it('--global is a scope of its own: identity and global pages go, projects stay', () => {
    seedStore();
    const run = runCliTyped(['purge', '--global'], 'global');
    expect(run.status).toBe(0);
    expect(existsSync(join(home(), 'global', 'identity.md'))).toBe(false);
    expect(existsSync(join(home(), 'global', 'pages'))).toBe(false);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(true);
  });

  it('--session takes the last 8 characters and reaches un-integrated entries only', () => {
    seedStore();
    const id = '8f4c2b91-dead-beef-0000-1234abcd5678';
    const run = runCliTyped(['purge', '--session', id], id.slice(-8));
    expect(run.status).toBe(0);

    const inbox = readFileSync(join(home(), 'projects', KEY, 'inbox.md'), 'utf-8');
    expect(inbox).toContain('keep this one');
    expect(inbox).not.toContain('purge this one');
    // The limit is stated in the output, not only in the docs.
    expect(run.stdout).toContain('`--session` reaches un-integrated inbox entries only');
  });

  it('a page slug in two scopes exits 1 listing candidates and deletes neither', () => {
    seedStore();
    const run = runCli(['purge', 'shared']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`\`shared\` exists in 2 scopes: ${KEY}, global`);
    expect(existsSync(join(home(), 'global', 'pages', 'shared.md'))).toBe(true);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'shared.md'))).toBe(true);
  });

  it('the scope qualifier in that error is a command that actually resolves it', () => {
    seedStore();
    const run = runCliTyped(['purge', 'shared', '--project', KEY], 'shared');
    expect(run.status).toBe(0);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'shared.md'))).toBe(false);
    expect(existsSync(join(home(), 'global', 'pages', 'shared.md'))).toBe(true);
  });

  it('deletes an unambiguous page on its slug', () => {
    seedStore();
    expect(runCliTyped(['purge', 'deploy'], 'deploy').status).toBe(0);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(false);
  });

  it('--yes skips the prompt', () => {
    seedStore();
    const run = runCli(['purge', 'deploy', '--yes']);
    expect(run.status).toBe(0);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(false);
  });

  it('--dry-run previews and deletes nothing', () => {
    seedStore();
    const before = treeDigest(home());
    const run = runCli(['purge', '--all', '--dry-run', '--json']);
    expect(run.status).toBe(0);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(data['token']).toBe('DELETE ALL');
    expect(data['deleted']).toBe(false);
    expect(treeDigest(home())).toBe(before);
  });

  it('--export copies the targets before deleting them', () => {
    seedStore();
    const dest = join(createTempDir('mehmory-export'), 'out');
    expect(runCliTyped(['purge', '--global', '--export', dest], 'global').status).toBe(0);
    expect(existsSync(join(dest, 'global', 'identity.md'))).toBe(true);
    expect(readFileSync(join(dest, 'global', 'pages', 'shared.md'), 'utf-8')).toContain(
      '# shared (global)'
    );
    expect(existsSync(join(home(), 'global', 'identity.md'))).toBe(false);
  });

  it('aborts with exit 3 and deletes nothing when the export fails', () => {
    seedStore();
    const blocker = join(createTempDir('mehmory-export'), 'blocker');
    writeFileSync(blocker, 'a file where the export directory should be');
    const before = treeDigest(home());

    const run = runCliTyped(['purge', '--global', '--export', join(blocker, 'out')], 'global');
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('MEHMORY E_PURGE_FAILED');
    expect(run.stderr).toContain('Nothing was deleted');
    expect(treeDigest(home())).toBe(before);
  });

  it('exits 3 naming the dirty store when the commit fails after the delete', () => {
    seedStore();
    // Force it rather than read the code: a `.git` git cannot open makes `commitPaths`
    // fail *after* the working tree has already lost the files, which is the terminal
    // state criterion 11 requires an exit code and a remedy for.
    rmSync(join(home(), '.git'), { recursive: true, force: true });
    writeFileSync(join(home(), '.git'), 'gitdir: /nowhere-at-all\n');

    const run = runCliTyped(['purge', '--global'], 'global');
    expect(run.status).toBe(3);
    expect(existsSync(join(home(), 'global', 'identity.md'))).toBe(false);
    expect(run.stderr).toContain('MEHMORY E_PURGE_FAILED');
    expect(run.stderr).toContain('The content is deleted but the store is left dirty');
    expect(run.stderr).toContain(`Fix: git -C ${home()} commit -a -m "purge"`);
  });

  // ─── usage and fail-open ───

  it('exits 2 when the store path is a file', () => {
    const file = join(createTempDir('mehmory-not-a-store'), 'store');
    writeFileSync(file, 'not a directory');
    const run = runCli(['purge', '--all'], { mehmoryHome: file });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('MEHMORY E_STORE_INIT');
    expect(run.stderr).not.toContain('at Object.');
  });

  it('survives an unparseable config.json with a templated result, not a throw', () => {
    seedStore();
    writeFileSync(join(home(), 'config.json'), '{ not json at all');
    const run = runCli(['purge', '--all']);
    expect(run.status).toBe(4);
    expect(run.stderr).not.toContain('at Object.');
  });

  it('needs something to delete', () => {
    seedStore();
    const run = runCli(['purge']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('needs something to delete');
  });

  it('deletes one thing at a time', () => {
    seedStore();
    const run = runCli(['purge', '--all', '--global']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('deletes one thing at a time');
  });
});
