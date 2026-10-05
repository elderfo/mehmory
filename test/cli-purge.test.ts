/**
 * `mehmory purge` — criterion 11, plus criterion 20's purge half.
 *
 * This is the only destructive command in the product and the only path to exit 4, so
 * every branch below asserts what is left on disk, not just the status code.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    expect(run.stderr).toContain("printf '%s\\n' 'DELETE ALL' | mehmory 'purge' '--all'");
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
    expect(run.stdout).toContain(
      `git -C '${home()}' filter-repo --path 'global' --path 'projects' --invert-paths`
    );
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

  it('previews and removes only normative catalog lines, preserving other lines', () => {
    seedStore();
    const index = write(
      `projects/${KEY}/index.md`,
      '# Index\n- [[deploy]] — deleted summary\n  - [[deploy]]\n- [[shared]] — keep summary\n'
    );
    const preview = runCli(['purge', 'deploy', '--dry-run']);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(`  clear  1 index lines in projects/${KEY}/index.md`);
    expect(preview.stdout).toContain('- [[deploy]] — deleted summary');
    expect(readFileSync(index, 'utf-8')).toContain('deleted summary');

    const dest = createTempDir('mehmory-page-export');
    expect(runCli(['purge', 'deploy', '--yes', '--export', dest]).status).toBe(0);
    expect(readFileSync(index, 'utf-8')).toBe(
      '# Index\n  - [[deploy]]\n- [[shared]] — keep summary\n'
    );
    expect(readFileSync(join(dest, 'projects', KEY, 'index.md'), 'utf-8')).toBe(
      '- [[deploy]] — deleted summary\n'
    );
    expect(
      spawnSync('git', ['status', '--porcelain'], { cwd: home(), encoding: 'utf-8' }).stdout
    ).toBe('');
  });

  it('purges an archived page returned by search', () => {
    seedStore();
    const archived = write(
      `projects/${KEY}/archive/old-deploy.md`,
      '# old-deploy\narchived deployment recipe\n'
    );
    expect(runCli(['search', 'old-deploy', '--all']).stdout).toContain('archive/old-deploy.md');
    expect(runCli(['purge', 'old-deploy', '--dry-run']).stdout).toContain(
      `  delete projects/${KEY}/archive/old-deploy.md`
    );
    expect(runCli(['purge', 'old-deploy', '--yes']).status).toBe(0);
    expect(existsSync(archived)).toBe(false);
  });

  it('purges live and archived copies in the same scope without false ambiguity', () => {
    seedStore();
    const archived = write(`projects/${KEY}/archive/deploy.md`, '# older deployment recipe\n');
    const preview = runCli(['purge', 'deploy', '--dry-run', '--json']);
    expect(preview.status).toBe(0);
    expect((envelopeOf(preview)['data'] as Record<string, unknown>)['targets']).toEqual([
      `projects/${KEY}/pages/deploy.md`,
      `projects/${KEY}/archive/deploy.md`,
    ]);
    expect(runCli(['purge', 'deploy', '--yes']).status).toBe(0);
    expect(existsSync(archived)).toBe(false);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(false);
  });

  it('purges agent pages and archive copies with their catalog lines', () => {
    seedStore();
    const page = write('agents/helper/pages/self-style.md', '# self-style\n');
    const archived = write('agents/helper/archive/self-style.md', '# old self-style\n');
    const index = write('agents/helper/index.md', '- [[self-style]] — private style\n');
    expect(runCli(['purge', 'self-style', '--dry-run']).stdout).toContain('agent/helper');
    expect(runCli(['purge', 'self-style', '--yes']).status).toBe(0);
    expect(existsSync(page)).toBe(false);
    expect(existsSync(archived)).toBe(false);
    expect(readFileSync(index, 'utf-8')).toBe('');
  });

  it('--global previews and removes the whole global directory without rewriting history', () => {
    seedStore();
    write('global/index.md', '- [[shared]] — private summary\n');
    write('global/inbox.md', 'private inbox\n');
    write('global/log.md', 'private log\n');
    write('global/archive/old.md', 'private archive\n');
    const preview = runCli(['purge', '--global', '--dry-run', '--json']);
    expect((envelopeOf(preview)['data'] as Record<string, unknown>)['targets']).toEqual(['global']);
    expect(runCliTyped(['purge', '--global'], 'global').status).toBe(0);
    expect(existsSync(join(home(), 'global'))).toBe(false);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(true);
    expect(
      spawnSync('git', ['show', 'HEAD^:global/log.md'], { cwd: home(), encoding: 'utf-8' }).stdout
    ).toBe('private log\n');
  });

  it.each(['', 'short', '1234567', 'session with spaces'])(
    'rejects session id %j with exit 1 before confirmation',
    id => {
      seedStore();
      write(
        'global/inbox.md',
        `- empty source <!--mehmory id=00000000000000a3 src=${id} ts=2026-07-30T10:00:00Z-->\n`
      );
      const before = treeDigest(home());
      const run = runCliTyped(['purge', `--session=${id}`, '--json'], '');
      expect(run.status).toBe(1);
      expect((envelopeOf(run)['errors'] as Record<string, unknown>[])[0]?.['code']).toBe('E_USAGE');
      expect(treeDigest(home())).toBe(before);
    }
  );

  it('reports partial inbox clears and uncommitted deletions precisely', () => {
    seedStore();
    const id = '8f4c2b91-dead-beef-0000-1234abcd5678';
    write(
      'global/inbox.md',
      `- global secret <!--mehmory id=00000000000000a3 src=${id} ts=2026-07-30T10:00:00Z-->\n`
    );
    write(`.state/locks/${KEY.replace(/\//g, '_')}.lock`, String(process.pid));
    const run = runCli(['purge', '--session', id, '--yes', '--json']);
    expect(run.status).toBe(3);
    const error = (envelopeOf(run)['errors'] as Record<string, unknown>[])[0];
    expect(error?.['consequence']).toBe(
      '0 of 0 paths and 1 of 2 selected inbox entries were deleted; 1 selected inbox entries remain; no purge commit was made'
    );
    expect(error?.['fix']).toBe(`git -C '${home()}' status`);
    expect(readFileSync(join(home(), 'global', 'inbox.md'), 'utf-8')).toBe('');
    expect(readFileSync(join(home(), 'projects', KEY, 'inbox.md'), 'utf-8')).toContain(
      'purge this one'
    );
    expect(
      spawnSync('git', ['log', '-1', '--format=%s'], {
        cwd: home(),
        encoding: 'utf-8',
      }).stdout.trim()
    ).toBe('init: store');
  });

  it('refuses a symlinked page before changing its index or exporting anything', () => {
    seedStore();
    const index = write(`projects/${KEY}/index.md`, '- [[deploy]] — keep summary\n');
    const outside = createTempDir('mehmory-outside');
    const source = join(outside, 'deploy.md');
    writeFileSync(source, 'outside secret\n');
    const page = join(home(), 'projects', KEY, 'pages', 'deploy.md');
    rmSync(page);
    symlinkSync(source, page);
    const before = treeDigest(home());
    const refused = runCli(['purge', 'deploy', '--yes', '--json']);
    expect(refused.status).toBe(3);
    expect((envelopeOf(refused)['data'] as Record<string, unknown>)['deleted']).toBe(false);
    expect(readFileSync(index, 'utf-8')).toBe('- [[deploy]] — keep summary\n');
    expect(treeDigest(home())).toBe(before);
    const dest = createTempDir('mehmory-export');
    const run = runCli(['purge', 'deploy', '--yes', '--export', dest, '--json']);
    expect(run.status).toBe(3);
    const envelope = envelopeOf(run);
    expect((envelope['data'] as Record<string, unknown>)['deleted']).toBe(false);
    expect((envelope['errors'] as Record<string, unknown>[])[0]?.['consequence']).toBe(
      'Nothing was deleted'
    );
    expect(readFileSync(index, 'utf-8')).toBe('- [[deploy]] — keep summary\n');
    expect(readFileSync(source, 'utf-8')).toBe('outside secret\n');
    expect(readdirSync(dest)).toEqual([]);
    expect(treeDigest(home())).toBe(before);
  });

  it('preflights every copy before touching the catalog without export', () => {
    seedStore();
    const index = write(`projects/${KEY}/index.md`, '- [[deploy]] — keep summary\n');
    const outside = join(createTempDir('mehmory-outside'), 'deploy.md');
    writeFileSync(outside, 'outside archive\n');
    mkdirSync(join(home(), 'projects', KEY, 'archive'), { recursive: true });
    symlinkSync(outside, join(home(), 'projects', KEY, 'archive', 'deploy.md'));
    const before = treeDigest(home());
    const run = runCli(['purge', 'deploy', '--yes', '--json']);
    expect(run.status).toBe(3);
    expect((envelopeOf(run)['data'] as Record<string, unknown>)['deleted']).toBe(false);
    expect((envelopeOf(run)['errors'] as Record<string, unknown>[])[0]?.['consequence']).toBe(
      'Nothing was deleted'
    );
    expect(readFileSync(index, 'utf-8')).toBe('- [[deploy]] — keep summary\n');
    expect(readFileSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'), 'utf-8')).toBe(
      '# deploy\n'
    );
    expect(treeDigest(home())).toBe(before);
  });

  it.each(['pages', 'archive'])(
    'refuses a symlinked %s directory before export and deletion',
    corpus => {
      seedStore();
      const outside = createTempDir('mehmory-outside');
      writeFileSync(join(outside, 'deploy.md'), 'outside secret\n');
      const dir = join(home(), 'projects', KEY, corpus);
      rmSync(dir, { recursive: true, force: true });
      symlinkSync(outside, dir);
      const before = treeDigest(home());
      const dest = createTempDir('mehmory-export');
      const run = runCli(['purge', 'deploy', '--yes', '--export', dest, '--json']);
      expect(run.status).toBe(3);
      expect((envelopeOf(run)['data'] as Record<string, unknown>)['deleted']).toBe(false);
      expect((envelopeOf(run)['errors'] as Record<string, unknown>[])[0]?.['consequence']).toBe(
        'Nothing was deleted'
      );
      expect(readdirSync(dest)).toEqual([]);
      expect(readFileSync(join(outside, 'deploy.md'), 'utf-8')).toBe('outside secret\n');
      expect(treeDigest(home())).toBe(before);
    }
  );

  it('preflights the index before exporting the page', () => {
    seedStore();
    const outside = join(createTempDir('mehmory-outside'), 'index.md');
    writeFileSync(outside, '- [[deploy]] — outside summary\n');
    symlinkSync(outside, join(home(), 'projects', KEY, 'index.md'));
    const dest = createTempDir('mehmory-export');
    const run = runCli(['purge', 'deploy', '--yes', '--export', dest, '--json']);
    expect(run.status).toBe(3);
    expect((envelopeOf(run)['errors'] as Record<string, unknown>[])[0]?.['consequence']).toBe(
      'Nothing was deleted'
    );
    expect(readdirSync(dest)).toEqual([]);
    expect(readFileSync(outside, 'utf-8')).toBe('- [[deploy]] — outside summary\n');
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(true);
  });

  it('resolves an ambiguous agent page with the suggested agent qualifier', () => {
    seedStore();
    const page = write('agents/helper/pages/shared.md', '# shared (agent)\n');
    const ambiguous = runCli(['purge', 'shared', '--json']);
    expect(ambiguous.status).toBe(1);
    expect((envelopeOf(ambiguous)['errors'] as Record<string, unknown>[])[0]?.['fix']).toBe(
      'mehmory purge shared --agent helper'
    );
    const run = runCli(['purge', 'shared', '--agent', 'helper', '--yes']);
    expect(run.status).toBe(0);
    expect(existsSync(page)).toBe(false);
    expect(readFileSync(join(home(), 'global', 'pages', 'shared.md'), 'utf-8')).toBe(
      '# shared (global)\n'
    );
    expect(readFileSync(join(home(), 'projects', KEY, 'pages', 'shared.md'), 'utf-8')).toBe(
      '# shared (project)\n'
    );
  });

  it.each(['../helper', '', 'with space'])('validates the agent qualifier %j', agent => {
    seedStore();
    const before = treeDigest(home());
    const run = runCli(['purge', 'shared', `--agent=${agent}`, '--yes', '--json']);
    expect(run.status).toBe(1);
    expect((envelopeOf(run)['errors'] as Record<string, unknown>[])[0]?.['what']).toBe(
      '`--agent` requires a safe single-segment agent name'
    );
    expect(treeDigest(home())).toBe(before);
  });

  it('requires a page slug for the agent qualifier', () => {
    seedStore();
    const run = runCli(['purge', '--agent', 'helper', '--yes', '--json']);
    expect(run.status).toBe(1);
    expect((envelopeOf(run)['errors'] as Record<string, unknown>[])[0]?.['what']).toBe(
      '`--agent` requires a page slug'
    );
  });

  it('keeps agent and aliased project scopes distinct when their labels collide', () => {
    seedStore();
    write('config.json', JSON.stringify({ identity: { aliases: { [KEY]: 'agent/helper' } } }));
    rmSync(join(home(), 'projects', KEY), { recursive: true });
    write('projects/agent/helper/inbox.md', '');
    const projectPage = write('projects/agent/helper/pages/collision.md', '# project copy\n');
    const agentPage = write('agents/helper/pages/collision.md', '# agent copy\n');
    const ambiguous = runCli(['purge', 'collision', '--yes', '--json']);
    expect(ambiguous.status).toBe(1);
    expect(readFileSync(projectPage, 'utf-8')).toBe('# project copy\n');
    expect(readFileSync(agentPage, 'utf-8')).toBe('# agent copy\n');
    expect(runCli(['purge', 'collision', '--project', KEY, '--yes']).status).toBe(0);
    expect(existsSync(projectPage)).toBe(false);
    expect(readFileSync(agentPage, 'utf-8')).toBe('# agent copy\n');
    write('projects/agent/helper/pages/collision.md', '# project copy\n');
    expect(runCli(['purge', 'collision', '--agent', 'helper', '--yes']).status).toBe(0);
    expect(existsSync(agentPage)).toBe(false);
    expect(readFileSync(projectPage, 'utf-8')).toBe('# project copy\n');
  });

  it('omits empty index edits from text and JSON previews', () => {
    seedStore();
    write(`projects/${KEY}/index.md`, '- [[shared]] — keep summary\n');
    const preview = runCli(['purge', 'deploy', '--dry-run']);
    expect(preview.status).toBe(0);
    expect(preview.stdout).not.toContain('clear  0 index lines');
    const json = runCli(['purge', 'deploy', '--dry-run', '--json']);
    expect((envelopeOf(json)['data'] as Record<string, unknown>)['indexEdits']).toEqual([]);
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
    expect(run.stderr).toContain(`Fix: git -C '${home()}' commit -a -m purge`);
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
