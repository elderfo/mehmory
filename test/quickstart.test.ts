/**
 * Criterion 17 — the TTHW release gate, as a script.
 *
 * Runs the README's "First 5 minutes" against a fresh temp `MEHMORY_HOME` and a temp fake
 * `~/.claude`, spawning the **built** `dist/cli.mjs` exactly as a user's shell would, and
 * asserts each step's documented expected output plus total wall time under budget.
 *
 * **Reach, stated where it is measured (criterion 16 says the same in the KPI table):** the
 * two model-driven steps — README step 4's live Claude Code session and `/mehmory:integrate`,
 * and step 5's second session — are asserted **by fixture, not by execution**. Nothing here
 * starts a session or runs a model. This gate measures the CLI half of TTHW and no more.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeClaudeHome, createTempDir } from './helpers.js';
import { fakeInstalledPlugin, runCli, treeDigest } from './cli-fixture.js';

/** The spec's release gate. The CLI half runs in seconds; the budget is the published one. */
const TTHW_BUDGET_MS = 5 * 60 * 1000;

const repoFile = (name: string): string => readFileSync(join(process.cwd(), name), 'utf-8');

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

describe('README “First 5 minutes”, end to end against the built binary', () => {
  it('runs install → init → onboard --dry-run → onboard → search inside the TTHW budget', () => {
    const started = Date.now();
    const home = process.env.MEHMORY_HOME ?? '';
    const project = createTempDir('mehmory-quickstart-project');
    // One fake HOME carrying both the transcripts step 3 mines and the installed plugin
    // step 1 tells the user to add.
    const claudeHome = fakeInstalledPlugin(
      undefined,
      createFakeClaudeHome({
        [project]: {
          'session-quickstart': transcript('session-quickstart', [
            'we decided to use pnpm for this repo, never npm',
          ]),
        },
      })
    );
    const cli = (args: readonly string[]): ReturnType<typeof runCli> =>
      runCli(args, { cwd: project, claudeHome });

    // ── Step 1. Install. The install-equivalent of `npm install -g mehmory` is that the
    // built bundle runs standalone; `--version` is the cheapest proof it was installed.
    const version = cli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    // ── Step 2. `mehmory init`. Documented output: a summary of what was created, plus a
    // next step prefixed for the shell reader.
    const init = cli(['init']);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain(`store ready at ${home}`);
    expect(init.stdout).toContain('next:');
    expect(init.stdout).toContain('in a Claude Code session, run');
    expect(existsSync(join(home, '.gitignore'))).toBe(true);
    expect(readFileSync(join(home, 'config.json'), 'utf-8').trim()).toBe('{}');

    // README: "Running this twice is a no-op — expect no errors and no changes to your store".
    const afterFirstInit = treeDigest(home);
    expect(cli(['init']).status).toBe(0);
    expect(treeDigest(home)).toBe(afterFirstInit);

    // `doctor` here exits 5, by construction, and the README never claims otherwise: `init`
    // does not commit, and doctor's git check wants a tree with commits. Warnings only — no
    // error-level finding — so 5, not 6. Pinned so a future "tidy up doctor" cannot quietly
    // turn a documented-clean first run into a red one.
    expect(cli(['doctor']).status).toBe(5);

    // ── Step 3. `mehmory onboard --dry-run` writes nothing.
    const dryRun = cli(['onboard', '--dry-run']);
    expect(dryRun.status).toBe(0);
    expect(treeDigest(home)).toBe(afterFirstInit);

    // ── Step 3. `mehmory onboard` seeds the inbox and the stub `project.md`.
    const onboard = cli(['onboard']);
    expect(onboard.status).toBe(0);
    const key = /(?:^|\s)(\S+\/\S+)/.exec(onboard.stdout)?.[1];
    const inbox = join(home, 'projects', key ?? '', 'inbox.md');
    expect(existsSync(inbox), `inbox for ${String(key)}`).toBe(true);
    expect(readFileSync(inbox, 'utf-8')).toContain('pnpm');
    expect(existsSync(join(home, 'projects', key ?? '', 'project.md'))).toBe(true);

    // ── Step 6. `mehmory search`. Straight after onboarding there is nothing to find:
    // onboard fills the **inbox**, and `search` scans pages + archive + log (criterion 7).
    // README steps 4–5 — the integrate that turns inbox entries into a page — are exactly
    // the model-driven work this gate does not execute. Empty result, exit 0, not an error.
    const beforeIntegrate = cli(['search', 'pnpm']);
    expect(beforeIntegrate.status).toBe(0);
    expect(beforeIntegrate.stdout).toContain('no hits');

    // The integrate step, asserted by fixture: a page with the fact on it is what
    // `/mehmory:integrate` produces. Written directly, never generated by a model here.
    const pagesDir = join(home, 'projects', key ?? '', 'pages');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, 'tooling.md'), '# Tooling\n\nWe use pnpm, never npm.\n');

    const search = cli(['search', 'pnpm']);
    expect(search.status).toBe(0);
    expect(search.stdout).toContain('pages/tooling.md');

    expect(Date.now() - started).toBeLessThan(TTHW_BUDGET_MS);
  });

  it('asserts the two model-driven steps by fixture, and says so where the user reads it', () => {
    // Steps 4 and 5 are not executed above. What is checked is that the documents describe
    // them and that the KPI table admits the gate's reach — criterion 16's caveat, criterion
    // 17's honesty requirement. If someone deletes the caveat, this fails.
    const readme = repoFile('README.md');
    expect(readme).toContain('/mehmory:integrate');
    expect(readme).toContain('permission'); // step 4's denial fork is a documented path
    expect(readme).toMatch(/second session/i); // step 5: the magical moment is not the first

    const spec = repoFile('docs/superpowers/specs/2026-07-28-mehmory-design.md');
    const tthwRow = spec.split('\n').find(line => line.includes('TTHW')) ?? '';
    expect(tthwRow).toContain('measured over the CLI steps');
    expect(tthwRow).toContain('fixture-asserted');
  });
});
