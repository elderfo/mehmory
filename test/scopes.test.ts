/** Project discovery and selector resolution (plan criterion 12). */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mehmoryHome } from '../src/core/home.js';
import { loadConfig } from '../src/core/config.js';
import { listAgentScopes, listProjects, resolveScope } from '../src/core/scopes.js';
import { agentScopePaths } from '../src/core/capture.js';

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

/** Create `agents/<name>/identity.md`, which is what makes a directory an agent scope. */
function seedAgentScope(name: string): void {
  const dir = join(mehmoryHome(), 'agents', name);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(join(dir, 'identity.md'), '# Who I am\n');
}

describe('listAgentScopes', () => {
  it('ignores a directory whose name is not a safe agent name', () => {
    // Hand-created, or created by something that is not mehmory. `agentScopePaths`
    // throws on such a name, so listing it would hand callers a value that detonates
    // the moment they use it.
    seedAgentScope('Scout');
    seedAgentScope('scout');

    expect(listAgentScopes().map(a => a.name)).toEqual(['scout']);
  });

  it('finds a directory holding identity.md', () => {
    seedAgentScope('scout');

    expect(listAgentScopes()).toEqual([
      { name: 'scout', dir: join(mehmoryHome(), 'agents', 'scout') },
    ]);
  });

  it('ignores a directory with no identity.md', () => {
    mkdirSync(join(mehmoryHome(), 'agents', 'halfborn', 'pages'), { recursive: true });
    seedAgentScope('scout');

    expect(listAgentScopes().map(a => a.name)).toEqual(['scout']);
  });

  it('ignores nested directories below one level', () => {
    seedAgentScope('scout');
    // An agent name is a single segment (`isSafeAgentName`), so anything deeper is
    // content inside a scope — never a scope of its own.
    const nested = join(mehmoryHome(), 'agents', 'scout', 'pages', 'impostor');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'identity.md'), '# Not a scope\n');

    expect(listAgentScopes().map(a => a.name)).toEqual(['scout']);
  });

  it('returns an empty list when the store has no agents dir (A2)', () => {
    expect(listAgentScopes()).toEqual([]);
  });

  it('lists two agent scopes independently', () => {
    seedAgentScope('scout');
    seedAgentScope('probe');

    expect(listAgentScopes()).toEqual([
      { name: 'probe', dir: join(mehmoryHome(), 'agents', 'probe') },
      { name: 'scout', dir: join(mehmoryHome(), 'agents', 'scout') },
    ]);
  });
});

describe('agentScopePaths', () => {
  it('resolves every file of the scope inside agents/<name>/', () => {
    const agentDir = join(mehmoryHome(), 'agents', 'scout');

    expect(agentScopePaths('scout')).toEqual({
      agentDir,
      identityFile: join(agentDir, 'identity.md'),
      indexFile: join(agentDir, 'index.md'),
      pagesDir: join(agentDir, 'pages'),
      logFile: join(agentDir, 'log.md'),
    });
  });

  it('exposes no inbox path — capture always writes the project inbox (KTD3)', () => {
    const paths = agentScopePaths('scout');

    expect(Object.keys(paths)).not.toContain('inboxFile');
    const composed: readonly string[] = [
      paths.agentDir,
      paths.identityFile,
      paths.indexFile,
      paths.pagesDir,
      paths.logFile,
    ];
    expect(composed.some(p => p.endsWith('inbox.md'))).toBe(false);
  });

  it('refuses a name failing isSafeAgentName rather than composing a path', () => {
    for (const name of ['..', '.', '', 'Scout', 'global', 'a/b', '../../tmp/pwned']) {
      expect(() => agentScopePaths(name)).toThrow();
    }
  });

  it('creates nothing — the agents/ root appears only on a write', () => {
    agentScopePaths('scout');

    expect(existsSync(join(mehmoryHome(), 'agents'))).toBe(false);
  });
});
