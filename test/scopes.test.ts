/** Project discovery and selector resolution (plan criterion 12). */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mehmoryHome } from '../src/core/home.js';
import { loadConfig } from '../src/core/config.js';
import { listProjects, resolveScope } from '../src/core/scopes.js';

/** Create `projects/<key>/inbox.md`, which is what makes a directory a project. */
function seedProject(key: string): void {
  const dir = join(mehmoryHome(), 'projects', ...key.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inbox.md'), '# Inbox\n');
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(mehmoryHome(), { recursive: true });
  writeFileSync(join(mehmoryHome(), 'config.json'), JSON.stringify(config));
}

describe('listProjects', () => {
  it('discovers nested keys, not the hostname directories above them', () => {
    seedProject('github.com/acme/widgets');
    seedProject('github.com/acme/gadgets');
    seedProject('local/0123456789ab');

    expect(listProjects().map(p => p.key)).toEqual([
      'github.com/acme/gadgets',
      'github.com/acme/widgets',
      'local/0123456789ab',
    ]);
  });

  it('ignores directories with no inbox.md', () => {
    mkdirSync(join(mehmoryHome(), 'projects', 'github.com', 'acme', 'empty'), {
      recursive: true,
    });
    seedProject('github.com/acme/widgets');

    expect(listProjects().map(p => p.key)).toEqual(['github.com/acme/widgets']);
  });

  it('returns an empty list when the store has no projects dir (A2)', () => {
    expect(listProjects()).toEqual([]);
  });

  it('reports the project directory alongside the key', () => {
    seedProject('github.com/acme/widgets');
    expect(listProjects()[0]?.dir).toBe(
      join(mehmoryHome(), 'projects', 'github.com', 'acme', 'widgets')
    );
  });
});

describe('resolveScope', () => {
  it('matches a full key', () => {
    seedProject('github.com/acme/widgets');
    const result = resolveScope('github.com/acme/widgets');
    expect(result.kind).toBe('match');
    expect(result.kind === 'match' && result.project.key).toBe('github.com/acme/widgets');
  });

  it('matches a unique substring', () => {
    seedProject('github.com/acme/widgets');
    seedProject('local/0123456789ab');

    const result = resolveScope('widg');
    expect(result.kind === 'match' && result.project.key).toBe('github.com/acme/widgets');
  });

  it('reports candidates for an ambiguous substring rather than picking one', () => {
    seedProject('github.com/acme/widgets');
    seedProject('github.com/acme/gadgets');

    const result = resolveScope('acme');
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toEqual([
      'github.com/acme/gadgets',
      'github.com/acme/widgets',
    ]);
  });

  it('reports no-match for a selector nothing carries', () => {
    seedProject('github.com/acme/widgets');
    expect(resolveScope('nothing-like-this').kind).toBe('none');
    expect(resolveScope('   ').kind).toBe('none');
  });

  it('resolves an alias SOURCE to the target the store actually holds (A5)', () => {
    seedProject('github.com/acme/widgets');
    writeConfig({
      identity: { aliases: { 'github.com/oldorg/widgets': 'github.com/acme/widgets' } },
    });

    const result = resolveScope('github.com/oldorg/widgets', loadConfig());
    expect(result.kind === 'match' && result.project.key).toBe('github.com/acme/widgets');
  });

  it('matches an alias source by substring too', () => {
    seedProject('github.com/acme/widgets');
    writeConfig({
      identity: { aliases: { 'github.com/oldorg/widgets': 'github.com/acme/widgets' } },
    });

    expect(
      (r => r.kind === 'match' && r.project.key)(resolveScope('oldorg', loadConfig()))
    ).toBe('github.com/acme/widgets');
  });

  it('does not report ambiguity when an alias and its target name one project', () => {
    seedProject('github.com/acme/widgets');
    writeConfig({
      identity: { aliases: { 'github.com/acme/widgets-old': 'github.com/acme/widgets' } },
    });

    expect(resolveScope('widgets', loadConfig()).kind).toBe('match');
  });

  it('ignores an alias whose target has no directory', () => {
    seedProject('github.com/acme/widgets');
    writeConfig({ identity: { aliases: { ghost: 'github.com/acme/nothing' } } });

    expect(resolveScope('ghost', loadConfig()).kind).toBe('none');
  });
});
