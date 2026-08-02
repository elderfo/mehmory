/**
 * `mehmory init --host codex` — issue #21, through the built-CLI seam.
 *
 * The point of this suite is not "it installed". `~/.codex/hooks.json` is a file other
 * tools already own — `context-mode` and `herdr` hold entries in it on the machine this
 * was measured against — so the assertions that matter are the hostile ones: a foreign
 * entry survives install → re-install → uninstall byte-identically, a re-install produces
 * exactly one set of mehmory entries, and a file mehmory cannot parse is refused rather
 * than overwritten.
 *
 * Every run points `CODEX_HOME` at a fresh temp directory. `hermeticEnv()` re-checks it
 * on the way into the child, so a test that computed the wrong path fails loudly instead
 * of touching the developer's real Codex configuration.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempDir } from './helpers.js';
import { envelopeOf, runCli } from './cli-fixture.js';

/** A `hooks.json` owned entirely by another tool, formatted the way Codex writes it. */
const FOREIGN_HOOKS = `${JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ command: '/usr/local/bin/other-tool hook codex sessionstart', type: 'command' }] },
        { hooks: [{ command: "bash '/home/u/.codex/herdr-agent-state.sh' session", timeout: 10, type: 'command' }] },
      ],
      PreToolUse: [{ hooks: [{ command: '/usr/local/bin/other-tool hook codex pretooluse', type: 'command' }] }],
    },
  },
  null,
  2
)}\n`;

interface Fixture {
  readonly codexHome: string;
  readonly hooksFile: string;
  readonly configFile: string;
}

function codexFixture(files: { hooks?: string; config?: string } = {}): Fixture {
  const codexHome = createTempDir('mehmory-test-codex-case');
  const hooksFile = join(codexHome, 'hooks.json');
  const configFile = join(codexHome, 'config.toml');
  if (files.hooks !== undefined) writeFileSync(hooksFile, files.hooks);
  if (files.config !== undefined) writeFileSync(configFile, files.config);
  return { codexHome, hooksFile, configFile };
}

function init(fixture: Fixture, ...args: readonly string[]): ReturnType<typeof runCli> {
  return runCli(['init', '--host', 'codex', ...args], { codexHome: fixture.codexHome });
}

function hooksDoc(fixture: Fixture): { hooks: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(fixture.hooksFile, 'utf-8')) as { hooks: Record<string, unknown[]> };
}

/** Every command string in the file, flattened out of the event → group → hook nesting. */
function commands(fixture: Fixture): string[] {
  const doc = hooksDoc(fixture);
  return Object.values(doc.hooks).flatMap(groups =>
    groups.flatMap(group => {
      const entries = (group as { hooks?: { command?: string }[] }).hooks ?? [];
      return entries.map(entry => entry.command ?? '');
    })
  );
}

const mehmoryCommands = (fixture: Fixture): string[] =>
  commands(fixture).filter(c => c.split(/\s+/).includes('--mehmory'));

describe('mehmory init --host codex', () => {
  it('writes the four Codex hooks and turns the hooks feature on', () => {
    const fixture = codexFixture({ config: 'model = "gpt-5"\n' });
    const run = init(fixture);
    expect(run.status).toBe(0);

    // SessionEnd is deliberately absent: Codex has no session-end event.
    expect(Object.keys(hooksDoc(fixture).hooks).sort()).toEqual([
      'PreCompact',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    for (const command of mehmoryCommands(fixture)) {
      expect(command).toMatch(/^node .*\.mjs codex --mehmory$/);
    }
    expect(readFileSync(fixture.configFile, 'utf-8')).toContain('[features]\nhooks = true');
    // The pre-existing setting is still there, not rewritten around the flag.
    expect(readFileSync(fixture.configFile, 'utf-8')).toContain('model = "gpt-5"');
  });

  it('creates both files when the Codex home is empty', () => {
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    expect(existsSync(fixture.hooksFile)).toBe(true);
    expect(readFileSync(fixture.configFile, 'utf-8')).toContain('hooks = true');
  });

  it('leaves the feature flag alone when it is already on', () => {
    const fixture = codexFixture({ config: '[features]\nhooks = true\n' });
    const before = readFileSync(fixture.configFile, 'utf-8');
    const data = envelopeOf(init(fixture, '--json'))['data'] as Record<string, unknown>;
    expect(data['featureFlag']).toBe('already-on');
    expect(readFileSync(fixture.configFile, 'utf-8')).toBe(before);
    // Nothing was modified, so nothing was backed up.
    expect(existsSync(`${fixture.configFile}.mehmory.bak`)).toBe(false);
  });

  it('flips the feature flag when it is explicitly off, keeping the rest of the table', () => {
    const fixture = codexFixture({
      config: 'model = "gpt-5"\n\n[features]\nsomething_else = 1\nhooks = false\n\n[tui]\nx = 1\n',
    });
    expect(init(fixture).status).toBe(0);
    const toml = readFileSync(fixture.configFile, 'utf-8');
    expect(toml).toContain('hooks = true');
    expect(toml).not.toContain('hooks = false');
    expect(toml).toContain('something_else = 1');
    expect(toml).toContain('[tui]\nx = 1');
  });

  it('adds the key to an existing [features] table rather than a second table', () => {
    const fixture = codexFixture({ config: '[features]\nother = true\n\n[tui]\nx = 1\n' });
    expect(init(fixture).status).toBe(0);
    const toml = readFileSync(fixture.configFile, 'utf-8');
    expect(toml.match(/^\[features]$/gm)?.length).toBe(1);
    expect(toml).toContain('other = true');
  });

  it('backs a file up before it modifies it', () => {
    const fixture = codexFixture({ hooks: FOREIGN_HOOKS, config: 'model = "gpt-5"\n' });
    const run = init(fixture);
    expect(run.stdout).toContain(`backed up to ${fixture.hooksFile}.mehmory.bak`);
    expect(readFileSync(`${fixture.hooksFile}.mehmory.bak`, 'utf-8')).toBe(FOREIGN_HOOKS);
    expect(readFileSync(`${fixture.configFile}.mehmory.bak`, 'utf-8')).toBe('model = "gpt-5"\n');
  });

  it('is idempotent — a second install writes nothing and leaves one set of entries', () => {
    const fixture = codexFixture({ hooks: FOREIGN_HOOKS });
    expect(init(fixture).status).toBe(0);
    const after = readFileSync(fixture.hooksFile, 'utf-8');
    expect(mehmoryCommands(fixture)).toHaveLength(4);

    const second = envelopeOf(init(fixture, '--json'))['data'] as Record<string, unknown>;
    expect(second['changed']).toEqual([]);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe(after);
    expect(mehmoryCommands(fixture)).toHaveLength(4);
  });

  it('replaces its own stale entry instead of adding a second one', () => {
    // The failure this guards: a plugin version bump moves the bundle path, and an
    // installer that matched on the path would leave the old entry behind.
    const fixture = codexFixture({
      hooks: `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'node /gone/v1/hooks/session-start.mjs codex --mehmory' }] },
            ],
          },
        },
        null,
        2
      )}\n`,
    });
    expect(init(fixture).status).toBe(0);
    expect(mehmoryCommands(fixture)).toHaveLength(4);
    expect(commands(fixture).some(c => c.includes('/gone/v1/'))).toBe(false);
  });

  it('a foreign entry survives install → re-install → uninstall, byte-identical', () => {
    const fixture = codexFixture({ hooks: FOREIGN_HOOKS });
    expect(init(fixture).status).toBe(0);
    expect(init(fixture).status).toBe(0);
    expect(init(fixture, '--uninstall').status).toBe(0);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe(FOREIGN_HOOKS);
  });

  it('byte-identical also when the file had no trailing newline — Codex writes it that way', () => {
    // Measured: the real `~/.codex/hooks.json` on the machine this was built against ends
    // without a newline. Appending one would put a spurious diff in a dotfile repository
    // every time mehmory was installed and removed again.
    const noNewline = FOREIGN_HOOKS.trimEnd();
    const fixture = codexFixture({ hooks: noNewline });
    expect(init(fixture).status).toBe(0);
    expect(readFileSync(fixture.hooksFile, 'utf-8').endsWith('\n')).toBe(false);
    expect(init(fixture, '--uninstall').status).toBe(0);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe(noNewline);
  });

  it('uninstall on a file of only foreign entries removes nothing', () => {
    const fixture = codexFixture({ hooks: FOREIGN_HOOKS });
    const run = init(fixture, '--uninstall', '--json');
    expect(run.status).toBe(0);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(data['changed']).toEqual([]);
    expect(data['backups']).toEqual([]);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe(FOREIGN_HOOKS);
  });

  it('uninstall leaves a valid file, not an empty shell of the events it removed', () => {
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    expect(init(fixture, '--uninstall').status).toBe(0);
    const doc = hooksDoc(fixture);
    expect(doc.hooks).toEqual({});
    expect(commands(fixture)).toEqual([]);
  });

  it('uninstall reformats a foreign hooks.json that is not already canonical 2-space JSON, but keeps every entry (D11)', () => {
    // The byte-identical guarantee above holds only under the documented assumption that
    // Codex itself wrote the file, which means canonical 2-space JSON. A hand-edited file
    // (here: 4-space indent) is content-correct after uninstall — nothing removed, nothing
    // invented — but is NOT byte-identical: renderHooksDoc() always re-serializes at 2-space,
    // so the file gets backed up and reformatted around a removal that touched nothing of
    // its own. See docs/CLI.md and docs/TROUBLESHOOTING.md for the user-facing note.
    const fourSpace = JSON.stringify(
      { hooks: { PreToolUse: [{ hooks: [{ command: '/usr/local/bin/other-tool hook', type: 'command' }] }] } },
      null,
      4
    );
    const fixture = codexFixture({ hooks: fourSpace });
    const run = init(fixture, '--uninstall', '--json');
    expect(run.status).toBe(0);
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    expect(data['changed']).toEqual([fixture.hooksFile]);
    expect(data['backups']).toEqual([`${fixture.hooksFile}.mehmory.bak`]);
    // Content correctness: the foreign entry is untouched.
    expect(hooksDoc(fixture)).toEqual(JSON.parse(fourSpace));
    // Byte identity does not hold: the file was rewritten at 2-space indent.
    expect(readFileSync(fixture.hooksFile, 'utf-8')).not.toBe(fourSpace);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe(JSON.stringify(JSON.parse(fourSpace), null, 2));
  });

  it('uninstall never turns the Codex hooks feature off — other tools depend on it', () => {
    const fixture = codexFixture({ config: 'model = "gpt-5"\n' });
    expect(init(fixture).status).toBe(0);
    const enabled = readFileSync(fixture.configFile, 'utf-8');
    expect(init(fixture, '--uninstall').status).toBe(0);
    expect(readFileSync(fixture.configFile, 'utf-8')).toBe(enabled);
  });

  it('refuses a malformed hooks.json rather than clobbering it', () => {
    const fixture = codexFixture({ hooks: '{ not json' });
    const run = init(fixture, '--json');
    expect(run.status).toBe(3);
    const envelope = envelopeOf(run);
    expect(envelope['ok']).toBe(false);
    const errors = envelope['errors'] as { code: string; fix?: string }[];
    expect(errors[0]?.code).toBe('E_CODEX_INSTALL');
    expect(errors[0]?.fix).toBe(`$EDITOR ${fixture.hooksFile}`);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe('{ not json');
  });

  it('refuses a hooks.json whose top level is not an object', () => {
    const fixture = codexFixture({ hooks: '[]' });
    expect(init(fixture, '--uninstall').status).toBe(3);
    expect(readFileSync(fixture.hooksFile, 'utf-8')).toBe('[]');
  });

  it('rejects an unknown host, and `--uninstall` on the default host', () => {
    const unknown = runCli(['init', '--host', 'emacs', '--json']);
    expect(unknown.status).toBe(1);
    expect(JSON.stringify(envelopeOf(unknown)['errors'])).toContain('unknown host');

    const wrong = runCli(['init', '--uninstall', '--json']);
    expect(wrong.status).toBe(1);
    expect(JSON.stringify(envelopeOf(wrong)['errors'])).toContain('plugin system');
  });

  it('points the hook commands at bundles that are actually on disk', () => {
    // A wrong bundle directory is invisible until a real Codex session fails silently,
    // so the install is only correct if the path it wrote resolves.
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    for (const command of mehmoryCommands(fixture)) {
      const path = /^node (.+)\.mjs codex/.exec(command)?.[1];
      expect(existsSync(`${path ?? ''}.mjs`), command).toBe(true);
    }
  });

  const skillsDir = (fixture: Fixture): string => join(fixture.codexHome, 'skills');

  it('installs the six skills as flat, prefix-named directories under $CODEX_HOME/skills', () => {
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    const names = readdirSync(skillsDir(fixture)).sort();
    expect(names).toEqual([
      'mehmory-integrate',
      'mehmory-lint',
      'mehmory-onboard-session',
      'mehmory-pause',
      'mehmory-remember',
      'mehmory-resume',
    ]);
    for (const name of names) {
      const skillName = name.replace(/^mehmory-/, '');
      const installed = readFileSync(join(skillsDir(fixture), name, 'SKILL.md'), 'utf-8');
      const source = readFileSync(resolve('skills', skillName, 'SKILL.md'), 'utf-8');
      // Byte-identical to the Claude Code copy — issue #17's whole point (one skill
      // document, both harnesses) and the reason the description-budget assertions in
      // plugin-skills-layout.test.ts don't need a second, Codex-side copy: whatever
      // holds for `skills/<name>/SKILL.md` holds here too, by construction.
      expect(installed).toBe(source);
    }
  });

  it('a foreign skill directory survives install → re-install → uninstall untouched', () => {
    const fixture = codexFixture();
    mkdirSync(join(skillsDir(fixture), 'gstack-review'), { recursive: true });
    writeFileSync(join(skillsDir(fixture), 'gstack-review', 'SKILL.md'), 'not mehmory\n');

    expect(init(fixture).status).toBe(0);
    expect(init(fixture).status).toBe(0);
    expect(init(fixture, '--uninstall').status).toBe(0);

    expect(readdirSync(skillsDir(fixture))).toEqual(['gstack-review']);
    expect(readFileSync(join(skillsDir(fixture), 'gstack-review', 'SKILL.md'), 'utf-8')).toBe('not mehmory\n');
  });

  it('uninstall removes every mehmory-* skill directory and nothing else', () => {
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    expect(init(fixture, '--uninstall').status).toBe(0);
    expect(existsSync(skillsDir(fixture))).toBe(true);
    expect(readdirSync(skillsDir(fixture))).toEqual([]);
  });

  it('a re-install rewrites nothing when the skill bodies are already current', () => {
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    const second = envelopeOf(init(fixture, '--json'))['data'] as Record<string, unknown>;
    // `changed` covers hooks.json/config.toml only by the time this assertion runs
    // above (see the idempotent-install test); this asserts the skill half of the same
    // property — the six directories are reported every time, not just on first write.
    expect((second['skills'] as string[]).sort()).toEqual([
      'mehmory-integrate',
      'mehmory-lint',
      'mehmory-onboard-session',
      'mehmory-pause',
      'mehmory-remember',
      'mehmory-resume',
    ]);
  });
});

describe('mehmory doctor — the Codex surface', () => {
  /** Findings of one doctor run against a Codex home, keyed by check id. */
  function findings(codexHome: string): Map<string, { level: string; message: string; code?: string; fix?: string }> {
    const run = runCli(['doctor', '--json'], { codexHome });
    const data = envelopeOf(run)['data'] as Record<string, unknown>;
    const list = data['findings'] as { check: string; level: string; message: string; code?: string }[];
    return new Map(list.map(f => [f.check, f]));
  }

  it('says nothing about Codex when neither Codex nor the install is present', () => {
    const fixture = codexFixture();
    const found = findings(fixture.codexHome);
    for (const check of ['codex.harness', 'codex.hooks_flag', 'codex.hooks', 'codex.skills']) {
      expect(found.has(check), check).toBe(false);
    }
  });

  it('reports all four checks once Codex is present, each with its error code', () => {
    const fixture = codexFixture({ config: 'model = "gpt-5"\n' });
    const found = findings(fixture.codexHome);
    expect(found.get('codex.harness')).toMatchObject({ level: 'ok' });
    expect(found.get('codex.hooks_flag')).toMatchObject({
      level: 'error',
      code: 'E_CODEX_HOOKS_DISABLED',
      fix: 'mehmory init --host codex',
    });
    expect(found.get('codex.hooks')).toMatchObject({
      level: 'error',
      code: 'E_CODEX_HOOKS_UNWIRED',
    });
    expect(found.get('codex.skills')).toMatchObject({
      level: 'warn',
      code: 'E_CODEX_SKILLS_MISSING',
    });
  });

  it('reports the flag as on when it is on, and as off when it is explicitly false', () => {
    const on = codexFixture({ config: '[features]\nhooks = true\n' });
    expect(findings(on.codexHome).get('codex.hooks_flag')).toMatchObject({ level: 'ok' });

    const off = codexFixture({ config: '[features]\nhooks = false\n' });
    expect(findings(off.codexHome).get('codex.hooks_flag')?.message).toContain('is false');
  });

  it('names the events that are missing after a partial uninstall', () => {
    const fixture = codexFixture({ config: '[features]\nhooks = true\n' });
    expect(init(fixture).status).toBe(0);
    expect(findings(fixture.codexHome).get('codex.hooks')).toMatchObject({ level: 'ok' });

    const doc = hooksDoc(fixture);
    delete doc.hooks['Stop'];
    writeFileSync(fixture.hooksFile, JSON.stringify(doc, null, 2));
    expect(findings(fixture.codexHome).get('codex.hooks')?.message).toContain('Stop');
  });

  it('reports mehmory wired into a Codex that is not there', () => {
    const fixture = codexFixture();
    expect(init(fixture).status).toBe(0);
    // Codex itself removed, mehmory's entries left behind.
    writeFileSync(fixture.configFile, '');
    const withConfig = findings(fixture.codexHome);
    expect(withConfig.get('codex.harness')).toMatchObject({ level: 'ok' });

    const orphan = codexFixture({
      hooks: `${JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/stop.mjs codex --mehmory' }] }] } },
        null,
        2
      )}\n`,
    });
    expect(findings(orphan.codexHome).get('codex.harness')).toMatchObject({
      level: 'error',
      code: 'E_CODEX_HARNESS_MISSING',
      fix: 'mehmory init --host codex --uninstall',
    });
  });

  it('reports an unparseable hooks.json as an error rather than as "not installed"', () => {
    const fixture = codexFixture({ hooks: '{ not json', config: '[features]\nhooks = true\n' });
    const found = findings(fixture.codexHome);
    expect(found.get('codex.hooks')).toMatchObject({
      level: 'error',
      code: 'E_CODEX_HOOKS_UNWIRED',
      fix: `$EDITOR ${fixture.hooksFile}`,
    });
  });

  it('passes the skills check once a mehmory skill is installed for Codex', () => {
    const fixture = codexFixture({ config: '[features]\nhooks = true\n' });
    mkdirSync(join(fixture.codexHome, 'skills', 'mehmory-integrate'), { recursive: true });
    expect(findings(fixture.codexHome).get('codex.skills')).toMatchObject({ level: 'ok' });
  });

  it('`mehmory init --host codex` alone is enough to turn codex.skills ok — the acceptance test for issue #25', () => {
    const fixture = codexFixture({ config: '[features]\nhooks = true\n' });
    expect(findings(fixture.codexHome).get('codex.skills')).toMatchObject({
      level: 'warn',
      code: 'E_CODEX_SKILLS_MISSING',
    });
    expect(init(fixture).status).toBe(0);
    expect(findings(fixture.codexHome).get('codex.skills')).toMatchObject({
      level: 'ok',
      message: 'mehmory skills installed for Codex',
    });
    expect(init(fixture, '--uninstall').status).toBe(0);
    expect(findings(fixture.codexHome).get('codex.skills')).toMatchObject({
      level: 'warn',
      code: 'E_CODEX_SKILLS_MISSING',
    });
  });
});
