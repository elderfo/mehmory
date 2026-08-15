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
import { executePurge, planAgent } from '../src/core/purge.js';
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

const OTHER_KEY = 'github.com/acme/gadgets';

/** An agent scope: `identity.md` is what makes the directory one, and it has no inbox. */
function seedAgent(name: string): void {
  write(`agents/${name}/identity.md`, `# ${name}\n`);
  write(`agents/${name}/pages/habits.md`, `# ${name} habits\n`);
}

/**
 * `seedStore()` plus two agent scopes and two project inboxes carrying `agent=` stamps.
 *
 * The second project is what proves KTD8: deleting `agents/scout/` alone leaves stamped
 * entries in *every* inbox, and the next integration would rebuild the scope from them.
 */
function seedAgentStore(): void {
  seedStore();
  seedAgent('scout');
  seedAgent('probe');
  write(
    `projects/${KEY}/inbox.md`,
    '- keep this one <!--mehmory id=00000000000000a1 src=session-keep ts=2026-07-30T10:00:00Z-->\n' +
      '- scout said this <!--mehmory id=00000000000000b1 src=session-a host=claude-code agent=scout ts=2026-07-30T10:00:00Z-->\n' +
      '- probe said this <!--mehmory id=00000000000000b2 src=session-a host=claude-code agent=probe ts=2026-07-30T10:00:00Z-->\n'
  );
  write(
    `projects/${OTHER_KEY}/inbox.md`,
    '- scout said this too <!--mehmory id=00000000000000b3 src=session-b0000000 host=claude-code agent=scout ts=2026-07-30T10:00:00Z-->\n'
  );
}

function inboxOf(key: string): string {
  return readFileSync(join(home(), 'projects', key, 'inbox.md'), 'utf-8');
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

describe('mehmory purge --agent', () => {
  it('removes the scope and every entry stamped with that name (KTD8)', () => {
    seedAgentStore();
    const run = runCliTyped(['purge', '--agent', 'scout'], 'scout');

    expect(run.status).toBe(0);
    expect(existsSync(join(home(), 'agents', 'scout'))).toBe(false);
    // Without the stamp sweep the next integration rebuilds the scope from these.
    expect(inboxOf(KEY)).not.toContain('scout said this');
    expect(inboxOf(OTHER_KEY)).not.toContain('scout said this too');
  });

  it('sweeps queued distill jobs, so the scope cannot drain back (KTD8)', () => {
    // SessionEnd distills but defers the write: entries wait in .state/queue until a
    // later SessionStart drains them into an inbox, and applyDistillJob preserves the
    // agent stamp. Sweeping only the inboxes leaves those, and the next session rebuilds
    // the scope the user just deleted.
    seedAgentStore();
    const queueDir = join(home(), '.state', 'queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      join(queueDir, 'deadbeefdeadbeef.json'),
      JSON.stringify({
        _jobType: 'distill-final',
        key: KEY,
        entries: [
          {
            id: 'aaaaaaaaaaaaaaaa',
            text: 'scout queued this',
            src: 'sess-q',
            host: 'claude-code',
            agent: 'scout',
            ts: '2026-08-15T12:00:00.000Z',
          },
        ],
      })
    );

    expect(runCliTyped(['purge', '--agent', 'scout'], 'scout').status).toBe(0);
    expect(existsSync(join(queueDir, 'deadbeefdeadbeef.json'))).toBe(false);
  });

  it('survives a queued job that vanishes between planning and execution', () => {
    // The queue is live — claimJob moves a job to claimed/ as a session drains it — so
    // the file can be gone by the time the purge runs. A destructive command must return
    // a structured outcome rather than throw ENOENT out of executePurge. Driven at the
    // core level because the window is between plan and execute, which the CLI does in
    // one process and gives a test no seam to reach into.
    seedAgentStore();
    const queueDir = join(home(), '.state', 'queue');
    mkdirSync(queueDir, { recursive: true });
    const jobPath = join(queueDir, 'facefacefaceface.json');
    writeFileSync(
      jobPath,
      JSON.stringify({
        _jobType: 'distill-final',
        key: KEY,
        entries: [
          {
            id: 'cccccccccccccccc',
            text: 'scout queued this',
            src: 'sess-q',
            host: 'claude-code',
            agent: 'scout',
            ts: '2026-08-15T12:00:00.000Z',
          },
        ],
      })
    );

    const plan = planAgent('scout', join(home(), 'agents', 'scout'));
    expect(plan.queueEdits ?? []).toHaveLength(1);

    // Something else drains the job after the plan is made.
    rmSync(jobPath);

    const exportDir = join(createTempDir('mehmory-purge-export'), 'out');
    const outcome = executePurge(plan, exportDir);

    expect(outcome.ok).toBe(true);
    expect(existsSync(join(home(), 'agents', 'scout'))).toBe(false);
  });

  it('rewrites a queued job shared with another agent instead of dropping it', () => {
    seedAgentStore();
    const queueDir = join(home(), '.state', 'queue');
    mkdirSync(queueDir, { recursive: true });
    const jobPath = join(queueDir, 'cafecafecafecafe.json');
    const entry = (id: string, agent: string, text: string): Record<string, unknown> => ({
      id,
      text,
      src: 'sess-q',
      host: 'claude-code',
      agent,
      ts: '2026-08-15T12:00:00.000Z',
    });
    writeFileSync(
      jobPath,
      JSON.stringify({
        _jobType: 'distill-final',
        key: KEY,
        entries: [
          entry('aaaaaaaaaaaaaaaa', 'scout', 'scout queued this'),
          entry('bbbbbbbbbbbbbbbb', 'probe', 'probe queued this'),
        ],
      })
    );

    expect(runCliTyped(['purge', '--agent', 'scout'], 'scout').status).toBe(0);

    expect(existsSync(jobPath)).toBe(true);
    const rewritten = readFileSync(jobPath, 'utf8');
    expect(rewritten).not.toContain('scout queued this');
    expect(rewritten).toContain('probe queued this');
  });

  it('leaves other agents, projects and global intact', () => {
    seedAgentStore();
    expect(runCliTyped(['purge', '--agent', 'scout'], 'scout').status).toBe(0);

    expect(existsSync(join(home(), 'agents', 'probe', 'identity.md'))).toBe(true);
    expect(existsSync(join(home(), 'projects', KEY, 'pages', 'deploy.md'))).toBe(true);
    expect(existsSync(join(home(), 'global', 'identity.md'))).toBe(true);
    expect(inboxOf(KEY)).toContain('keep this one');
    expect(inboxOf(KEY)).toContain('probe said this');
  });

  it('reports no match for an unknown name rather than creating one', () => {
    seedAgentStore();
    const run = runCli(['purge', '--agent', 'ghost']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no agent scope matches `ghost`');
    expect(existsSync(join(home(), 'agents', 'ghost'))).toBe(false);
  });

  it('pins the token to the resolved name, not the selector the user typed', () => {
    seedAgentStore();
    // Bare `--agent` is the case where the two can differ: nothing was typed at all.
    writeFileSync(join(home(), 'config.json'), JSON.stringify({ identity: { agent: 'scout' } }));

    const wrong = runCliTyped(['purge', '--agent'], '');
    expect(wrong.status).toBe(4);
    expect(wrong.stderr).toContain("'scout' | mehmory purge --agent");
    expect(existsSync(join(home(), 'agents', 'scout'))).toBe(true);

    const right = runCliTyped(['purge', '--agent'], 'scout');
    expect(right.status).toBe(0);
    expect(existsSync(join(home(), 'agents', 'scout'))).toBe(false);
  });

  it('--all removes agents/ along with global/ and projects/', () => {
    seedAgentStore();
    expect(runCliTyped(['purge', '--all'], 'DELETE ALL').status).toBe(0);

    expect(existsSync(join(home(), 'agents'))).toBe(false);
    expect(existsSync(join(home(), 'global'))).toBe(false);
    expect(existsSync(join(home(), 'projects'))).toBe(false);
  });

  it('--project leaves every agent scope intact', () => {
    seedAgentStore();
    expect(runCliTyped(['purge', '--project', KEY], KEY).status).toBe(0);

    expect(existsSync(join(home(), 'projects', KEY))).toBe(false);
    expect(existsSync(join(home(), 'agents', 'scout', 'identity.md'))).toBe(true);
    expect(existsSync(join(home(), 'agents', 'probe', 'identity.md'))).toBe(true);
  });

  it('--global still touches only global/identity.md and global/pages/', () => {
    seedAgentStore();
    expect(runCliTyped(['purge', '--global'], 'global').status).toBe(0);

    expect(existsSync(join(home(), 'global', 'identity.md'))).toBe(false);
    expect(existsSync(join(home(), 'agents', 'scout', 'identity.md'))).toBe(true);
    expect(existsSync(join(home(), 'agents', 'probe', 'identity.md'))).toBe(true);
  });

  it('--session leaves agent scopes untouched — they hold no inbox', () => {
    seedAgentStore();
    const id = 'session-b0000000';
    expect(runCliTyped(['purge', '--session', id], id.slice(-8)).status).toBe(0);

    expect(inboxOf(OTHER_KEY)).not.toContain('scout said this too');
    expect(existsSync(join(home(), 'agents', 'scout', 'identity.md'))).toBe(true);
    expect(existsSync(join(home(), 'agents', 'scout', 'pages', 'habits.md'))).toBe(true);
  });

  it('resolves a page slug against agent scopes, and --agent qualifies it', () => {
    seedAgentStore();
    const ambiguous = runCli(['purge', 'habits']);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain('agent:probe, agent:scout');
    expect(ambiguous.stderr).toContain('mehmory purge habits --agent probe');

    const run = runCliTyped(['purge', 'habits', '--agent', 'probe'], 'habits');
    expect(run.status).toBe(0);
    expect(existsSync(join(home(), 'agents', 'probe', 'pages', 'habits.md'))).toBe(false);
    expect(existsSync(join(home(), 'agents', 'scout', 'pages', 'habits.md'))).toBe(true);
  });
});
