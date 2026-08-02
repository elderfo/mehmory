/** `mehmory onboard` — criterion 5, plus criterion 20's onboard half. */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeClaudeHome, createTempDir, encodeClaudeProjectDir } from './helpers.js';
import { envelopeOf, runCli, treeDigest } from './cli-fixture.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

/** JSONL a transcript's user messages produce distillable entries from. */
function transcript(sessionId: string, texts: readonly string[]): readonly string[] {
  return texts.map((text, i) =>
    JSON.stringify({
      type: 'message',
      role: 'user',
      text,
      uuid: `${sessionId}-uuid-${String(i)}`,
      sessionId,
      timestamp: '2026-07-30T10:00:00Z',
    })
  );
}

/** A real, existing project directory — decode only accepts paths that exist. */
function fakeProject(): string {
  return createTempDir('mehmory-proj');
}

function inboxOf(key: string): string {
  const file = join(home(), 'projects', key, 'inbox.md');
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
}

function keyFromEnvelope(run: ReturnType<typeof runCli>): string {
  const data = envelopeOf(run)['data'] as Record<string, unknown>;
  return String(data['scope']);
}

describe('mehmory onboard', () => {
  it('distills the current project’s transcripts into its inbox', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { 'session-a': transcript('session-a', ['use pnpm, never npm']) },
    });
    expect(runCli(['init'], { cwd: project, claudeHome }).status).toBe(0);

    const run = runCli(['onboard', '--json'], { cwd: project, claudeHome });
    expect(run.status).toBe(0);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(data['candidates']).toBe(1);
    expect(Number(data['appended'])).toBeGreaterThan(0);
    expect(inboxOf(keyFromEnvelope(run))).toContain('use pnpm, never npm');
  });

  it('writes the stub project.md that keeps the empty-store nudge from firing', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['prefer vitest over jest here']) },
    });
    runCli(['init'], { cwd: project, claudeHome });
    const run = runCli(['onboard', '--json'], { cwd: project, claudeHome });
    const stub = join(home(), 'projects', keyFromEnvelope(run), 'project.md');
    expect(existsSync(stub)).toBe(true);
    // `storeIsUnpopulated()` reads this file, not the inbox — a non-empty body is
    // exactly what stops the next SessionStart pointing at `/mehmory:onboard-session`.
    expect(readFileSync(stub, 'utf-8').trim()).not.toBe('');
  });

  it('honors the user’s own secrets.patterns on the way in', () => {
    // The debt this closes: `distill()` redacted with the built-ins only, so a pattern
    // the user configured was applied on the capture path and *not* on this one.
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['the token is SEKRET-4711 keep it safe']) },
    });
    runCli(['init'], { cwd: project, claudeHome });
    writeFileSync(
      join(home(), 'config.json'),
      JSON.stringify({ secrets: { patterns: ['/SEKRET-[0-9]+/g'] } })
    );

    const run = runCli(['onboard', '--json'], { cwd: project, claudeHome });
    const inbox = inboxOf(keyFromEnvelope(run));
    expect(inbox).toContain('[REDACTED]');
    expect(inbox).not.toContain('SEKRET-4711');
  });

  it('lists a directory whose decoded path is gone as unresolvable, and never guesses', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['the session is still here']) },
      // Empty session map still creates the directory; the path itself never existed.
      '/tmp/mehmory-gone-3f9a1c/does-not-exist': {},
    });
    runCli(['init'], { cwd: project, claudeHome });

    const run = runCli(['onboard', '--json'], { cwd: project, claudeHome });
    expect(run.status).toBe(0);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(data['unresolvable']).toEqual([
      encodeClaudeProjectDir('/tmp/mehmory-gone-3f9a1c/does-not-exist'),
    ]);
    expect(data['scanned']).toBe(1);
  });

  it('caps the project scan and reports the remainder as unscanned', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['the first project note']) },
      [fakeProject()]: { t: transcript('t', ['the second project note']) },
      [fakeProject()]: { u: transcript('u', ['the third project note']) },
    });
    runCli(['init'], { cwd: project, claudeHome });
    const data = envelopeOf(
      runCli(['onboard', '--projects', '1', '--json'], { cwd: project, claudeHome })
    )['data'] as Record<string, unknown>;
    expect(data['scanned']).toBe(1);
    expect(data['unscanned']).toBe(2);
  });

  it('exits 0 with the in-session pointer when there is nothing to mine', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({});
    runCli(['init'], { cwd: project, claudeHome });
    const run = runCli(['onboard'], { cwd: project, claudeHome });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'no transcripts found — run `/mehmory:onboard-session` inside a Claude Code session in your project instead'
    );
  });

  it('--dry-run writes nothing at all', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['dry run me']) },
    });
    runCli(['init'], { cwd: project, claudeHome });

    const before = treeDigest(home());
    const run = runCli(['onboard', '--dry-run', '--json'], { cwd: project, claudeHome });
    expect(run.status).toBe(0);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(Number(data['entries'])).toBeGreaterThan(0);
    expect(data['appended']).toBe(0);
    expect(treeDigest(home())).toBe(before);
  });

  it('replays as a no-op: a second run appends nothing new', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['idempotent replay please']) },
    });
    runCli(['init'], { cwd: project, claudeHome });
    runCli(['onboard'], { cwd: project, claudeHome });
    const after = treeDigest(home());
    const second = envelopeOf(runCli(['onboard', '--json'], { cwd: project, claudeHome }))[
      'data'
    ] as Record<string, unknown>;
    expect(second['appended']).toBe(0);
    expect(Number(second['skipped'])).toBeGreaterThan(0);
    expect(treeDigest(home())).toBe(after);
  });

  it('deletes the resume state on completion', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['done means done']) },
    });
    runCli(['init'], { cwd: project, claudeHome });
    runCli(['onboard'], { cwd: project, claudeHome });
    expect(existsSync(join(home(), '.state', 'onboard.json'))).toBe(false);
  });

  it('--resume finishes an interrupted run to the same inbox as an uninterrupted one', () => {
    const project = fakeProject();
    const sessions = {
      'session-1': transcript('session-1', ['the first thing captured']),
      'session-2': transcript('session-2', ['the second thing captured']),
    };
    const claudeHome = createFakeClaudeHome({ [project]: sessions });
    runCli(['init'], { cwd: project, claudeHome });

    // The state an interrupted run leaves behind: scope stamped, one transcript done.
    const key = keyFromEnvelope(
      runCli(['onboard', '--dry-run', '--json'], { cwd: project, claudeHome })
    );
    const encoded = join(claudeHome, '.claude', 'projects', encodeClaudeProjectDir(project));
    mkdirSync(join(home(), '.state'), { recursive: true });
    writeFileSync(
      join(home(), '.state', 'onboard.json'),
      JSON.stringify({ scope: key, done: [join(encoded, 'session-1.jsonl')] })
    );

    const resumed = runCli(['onboard', '--resume', '--json'], { cwd: project, claudeHome });
    expect(resumed.status).toBe(0);
    const data = envelopeOf(resumed)['data'] as Record<string, unknown>;
    expect(data['alreadyDone']).toBe(1);
    expect(inboxOf(key)).toContain('second thing');
    expect(inboxOf(key)).not.toContain('first thing');
    expect(existsSync(join(home(), '.state', 'onboard.json'))).toBe(false);

    // Finishing the job the ordinary way converges on the same inbox as a single
    // uninterrupted run would have produced.
    runCli(['onboard'], { cwd: project, claudeHome });
    expect(inboxOf(key)).toContain('first thing');
    expect(inboxOf(key)).toContain('second thing');
  });

  it('--resume exits 1 when the recorded scope differs from the flags given', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({ [project]: { s: transcript('s', ['a note worth keeping']) } });
    runCli(['init'], { cwd: project, claudeHome });
    mkdirSync(join(home(), '.state'), { recursive: true });
    writeFileSync(
      join(home(), '.state', 'onboard.json'),
      JSON.stringify({ scope: 'github.com/somebody/else', done: [] })
    );

    const run = runCli(['onboard', '--resume'], { cwd: project, claudeHome });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the interrupted run was scoped to `github.com/somebody/else`');
  });

  it('--resume with nothing to resume exits 1', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({ [project]: { s: transcript('s', ['a note worth keeping']) } });
    runCli(['init'], { cwd: project, claudeHome });
    const run = runCli(['onboard', '--resume'], { cwd: project, claudeHome });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('found no interrupted run');
  });

  it('rejects `--all`, which it cannot act on, rather than failing to parse it', () => {
    const run = runCli(['onboard', '--all']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('`--all` has no meaning');
  });

  // ─── criterion 20: fail-open ───

  it('exits 2 when the store path is a file, without a stack trace', () => {
    const file = join(createTempDir('mehmory-not-a-store'), 'store');
    writeFileSync(file, 'not a directory');
    const run = runCli(['onboard'], { mehmoryHome: file });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('MEHMORY E_STORE_INIT');
    expect(run.stderr).not.toContain('at Object.');
  });

  it('skips an unreadable transcript and still succeeds', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { good: transcript('good', ['a readable transcript line']) },
    });
    // A directory where a transcript should be: EISDIR on read, on any platform and
    // any uid — unlike chmod, which root ignores.
    mkdirSync(
      join(claudeHome, '.claude', 'projects', encodeClaudeProjectDir(project), 'broken.jsonl')
    );
    runCli(['init'], { cwd: project, claudeHome });

    const run = runCli(['onboard', '--json'], { cwd: project, claudeHome });
    expect(run.status).toBe(0);
    expect(inboxOf(keyFromEnvelope(run))).toContain('readable');
  });

  it('survives a corrupt store: an inbox that is a directory costs entries, not a throw', () => {
    const project = fakeProject();
    const claudeHome = createFakeClaudeHome({
      [project]: { s: transcript('s', ['a corrupt store note']) },
    });
    runCli(['init'], { cwd: project, claudeHome });
    const key = keyFromEnvelope(
      runCli(['onboard', '--dry-run', '--json'], { cwd: project, claudeHome })
    );
    mkdirSync(join(home(), 'projects', key, 'inbox.md'), { recursive: true });

    const run = runCli(['onboard', '--json'], { cwd: project, claudeHome });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('at Object.');
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(data['appended']).toBe(0);
  });
});
