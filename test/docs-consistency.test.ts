/**
 * Criterion 15, enforcement half: the three script-prose pairs, each checked in **both**
 * directions. A one-way check passes while the docs describe a flag the binary dropped.
 *
 * - commands and flags: `--help` output ↔ `docs/CLI.md` (never a hand-written command list)
 * - `ERROR_KINDS` ↔ `docs/TROUBLESHOOTING.md`
 * - `MehmoryConfig` top-level keys ↔ `docs/CONFIG.md`
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './cli-fixture.js';
import { loadConfig } from '../src/core/config.js';

const docs = (name: string): string => readFileSync(join(process.cwd(), 'docs', name), 'utf-8');

/**
 * Documented once in `docs/CLI.md`'s Conventions section rather than under all seven
 * commands, so they are exempted from the per-command comparison and asserted there instead.
 */
const UNIVERSAL_FLAGS = new Set(['--json', '--help']);

const flagsIn = (text: string): ReadonlySet<string> =>
  new Set([...text.matchAll(/--[a-z][a-z-]*/g)].map(m => m[0]).filter(f => !UNIVERSAL_FLAGS.has(f)));

/** Every command the binary exposes, read off the top-level `--help`. */
function binaryCommands(): readonly string[] {
  const help = runCli(['--help']);
  expect(help.status).toBe(0);
  const block = /Commands:\n([\s\S]*?)\n\n/.exec(help.stdout)?.[1] ?? '';
  const names = [...block.matchAll(/^ {2}(\w[\w-]*)/gm)].map(m => m[1] ?? '');
  expect(names.length).toBeGreaterThan(0);
  return names;
}

/** `docs/CLI.md` split into one body per `### \`mehmory <name> …\`` heading. */
function documentedCommands(): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  const cli = docs('CLI.md');
  const headings = [...cli.matchAll(/^### `mehmory (\w[\w-]*)[^\n]*\n/gm)];
  headings.forEach((heading, i) => {
    const start = heading.index;
    const end = headings[i + 1]?.index ?? cli.length;
    sections.set(heading[1] ?? '', cli.slice(start, end));
  });
  return sections;
}

describe('docs/CLI.md ↔ the binary', () => {
  it('documents exactly the commands the binary exposes, and no others', () => {
    expect([...documentedCommands().keys()].sort()).toEqual([...binaryCommands()].sort());
  });

  it('documents exactly each command’s flags, in both directions', () => {
    const sections = documentedCommands();
    for (const name of binaryCommands()) {
      const help = runCli([name, '--help']);
      expect(help.status, name).toBe(0);
      const documented = flagsIn(sections.get(name) ?? '');
      const exposed = flagsIn(help.stdout);
      // Both directions in one assertion: a set difference either way is a failure, and
      // the message names the command and the offending flags.
      expect([...exposed].sort(), `flags of \`mehmory ${name}\``).toEqual([...documented].sort());
    }
  });

  it('documents the universal flags once, in Conventions', () => {
    const conventions = /## Conventions\n([\s\S]*?)\n## /.exec(docs('CLI.md'))?.[1] ?? '';
    for (const flag of [...UNIVERSAL_FLAGS, '--version', '-h', '-v']) {
      // Word-boundary: plain `toContain('-h')` is satisfied by the `-h` inside `--help`.
      expect(new RegExp(`(^|[^\\w-])${flag}([^\\w-]|$)`).test(conventions), flag).toBe(true);
    }
  });
});

describe('ERROR_KINDS ↔ docs/TROUBLESHOOTING.md', () => {
  /** Read off the registry literal: `ERROR_KINDS` is deliberately not exported. */
  const registry = (): readonly string[] => {
    const source = readFileSync(join(process.cwd(), 'src', 'core', 'errors.ts'), 'utf-8');
    const block = /const ERROR_KINDS = \{([\s\S]*?)\n\} as const/.exec(source)?.[1];
    expect(block, 'ERROR_KINDS literal not found in src/core/errors.ts').toBeDefined();
    return [...(block ?? '').matchAll(/^ {2}(E_[A-Z_]+):/gm)].map(m => m[1] ?? '');
  };

  it('documents every registry code, and documents no code that is not in the registry', () => {
    // `##` headings only: the CLI-level codes (`E_USAGE`, `E_ABORTED`, `E_DOCTOR_*`) are
    // deliberately not registry codes and live under `###` in their own section.
    const documented = [...docs('TROUBLESHOOTING.md').matchAll(/^## (E_[A-Z_]+)/gm)].map(
      m => m[1] ?? ''
    );
    expect(documented.sort()).toEqual([...registry()].sort());
  });
});

describe('MehmoryConfig ↔ docs/CONFIG.md', () => {
  it('documents every top-level config group, and no group that does not exist', () => {
    // `## \`snake_case\`` headings are config groups; `## \`MEHMORY_HOME\`` is an env var.
    const documented = [...docs('CONFIG.md').matchAll(/^## `([a-z][a-z_]*)`/gm)].map(m => m[1] ?? '');
    expect(documented.sort()).toEqual(Object.keys(loadConfig()).sort());
  });
});
