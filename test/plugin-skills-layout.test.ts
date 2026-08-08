/**
 * Plugin packaging — skills half of criterion 3.
 *
 * Asserts the shipped layout is real: six skills with parseable frontmatter, a manifest
 * that agrees with package.json, and no SKILL.md instructing the model to run a bundled
 * script that `pnpm build` does not produce.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimateTokens, INJECTION_BUDGET_TOKENS } from '../src/core/tokens.js';

const SKILLS = ['integrate', 'lint', 'onboard-session', 'remember', 'pause', 'resume'];

/** Combined ceiling for the always-on skill descriptions — the injection budget. */
const SKILL_DESCRIPTION_BUDGET_TOKENS = INJECTION_BUDGET_TOKENS;

/** Ceiling for any single description, so one skill cannot eat the shared budget. */
const SKILL_DESCRIPTION_TOKENS = 160;

/** Minimal YAML-ish frontmatter reader — the frontmatter is flat `key: value` only. */
function frontmatter(body: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (!match?.[1]) throw new Error('no frontmatter block');
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv?.[1]) {
      key = kv[1];
      fields[key] = kv[2] ?? '';
    } else if (key) {
      // Folded continuation line.
      fields[key] = `${fields[key] ?? ''} ${line.trim()}`;
    }
  }
  return fields;
}

const bodies = new Map(
  SKILLS.map(name => [name, readFileSync(resolve('skills', name, 'SKILL.md'), 'utf-8')])
);

describe('plugin skills layout', () => {
  it.each(SKILLS)('skills/%s/SKILL.md has the required frontmatter', name => {
    const fields = frontmatter(bodies.get(name) as string);
    expect(fields['name']).toBe(name);
    expect(fields['name']).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(fields['name']?.length).toBeLessThanOrEqual(64);
    expect(fields['name']).not.toContain('--');
    expect(fields['description']?.length).toBeGreaterThan(40);
    expect(fields['description']?.length).toBeLessThanOrEqual(1024);
    expect(fields['allowed-tools']?.length).toBeGreaterThan(0);
    expect(fields['allowed-tools']).not.toContain(',');
  });

  it('remember names the `remember:` prompt prefix in its description', () => {
    // The only run-2 surface that can teach the zero-latency path (criterion 17).
    expect(frontmatter(bodies.get('remember') as string)['description']).toContain('remember:');
  });

  it('every skill description warns that writes land in ~/.mehmory (spec gap 12)', () => {
    for (const [name, body] of bodies) {
      expect(frontmatter(body)['description'], name).toContain('~/.mehmory');
    }
  });

  // ─── Always-on cost ───
  //
  // Skill *bodies* load only when a skill is invoked, but every `description` is in
  // context from the first turn of every session, in every repo where the plugin is
  // installed — the same always-on channel as the injection frame, and the only part of
  // mehmory's context cost that nothing was measuring. A budget nobody enforces is a
  // budget that drifts: this is the enforcement half of the cap.
  //
  // Numbers: the six descriptions cost ~650 tokens today. The ceiling is set at the
  // injection budget (800) rather than at today's number, so ordinary rewording is free
  // and a new skill or a doubled description is not. Per-skill cap bounds any single
  // offender. Raise either deliberately, in a commit that says why — that is the point.
  it('every skill description stays inside the per-skill always-on budget', () => {
    for (const [name, body] of bodies) {
      const tokens = estimateTokens(frontmatter(body)['description'] ?? '');
      expect(tokens, `skills/${name} description`).toBeLessThanOrEqual(SKILL_DESCRIPTION_TOKENS);
    }
  });

  it('the skill descriptions together stay inside the always-on budget', () => {
    const total = [...bodies.values()].reduce(
      (sum, body) => sum + estimateTokens(frontmatter(body)['description'] ?? ''),
      0
    );
    expect(total).toBeLessThanOrEqual(SKILL_DESCRIPTION_BUDGET_TOKENS);
  });

  it('every bundled script a SKILL.md references exists after the build', () => {
    const referenced = new Set<string>();
    for (const body of bodies.values()) {
      for (const m of body.matchAll(/hooks\/([A-Za-z0-9._-]+\.mjs)/g)) {
        if (m[1]) referenced.add(m[1]);
      }
    }
    for (const script of referenced) {
      expect(existsSync(resolve('hooks', script)), `hooks/${script} missing — run pnpm build`).toBe(
        true
      );
    }
  });

  // Issue #17: the inbox helper is reachable through `mehmory inbox-tx`, so skills call
  // the binary instead of resolving a path through the Claude-Code-specific plugin-root
  // variable. Asserted with teeth (not a vacuous pass) — at least one skill must use it.
  it('skills reach the inbox helper through the CLI, not a plugin-root variable', () => {
    const usesCli = [...bodies.values()].some(body => body.includes('mehmory inbox-tx'));
    expect(usesCli).toBe(true);
    for (const [name, body] of bodies) {
      expect(body, name).not.toContain('CLAUDE_PLUGIN_ROOT');
    }
  });
});

describe('plugin manifest', () => {
  it('ships a canonical Agent Plugins v1 manifest at the package root', () => {
    const manifest = JSON.parse(readFileSync(resolve('plugin.json'), 'utf-8')) as {
      $schema: string;
      name: string;
      version: string;
      description: string;
      author: { name: string };
      homepage: string;
      repository: string;
      license: string;
      keywords: string[];
    };
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string };
    const version = readFileSync(resolve('VERSION'), 'utf-8').trim();

    expect(manifest.$schema).toBe(
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    );
    expect(manifest.name).toBe('mehmory');
    expect(manifest.version).toBe(version);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.author).toEqual({ name: 'Christopher Freddy Getsfred' });
    expect(manifest.license).toBe('MIT');
    expect(manifest.keywords).toContain('plugin');
    expect(Object.keys(manifest).sort()).toEqual(
      [
        '$schema',
        'author',
        'description',
        'homepage',
        'keywords',
        'license',
        'name',
        'repository',
        'version',
      ].sort()
    );
    expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect(manifest.name).not.toMatch(/--|\.\./);
  });

  it('keeps the Claude Code manifest in sync with the portable manifest', () => {
    const portable = JSON.parse(readFileSync(resolve('plugin.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const claude = JSON.parse(
      readFileSync(resolve('.claude-plugin/plugin.json'), 'utf-8')
    ) as Record<string, unknown>;

    for (const field of [
      'name',
      'version',
      'description',
      'author',
      'homepage',
      'repository',
      'license',
      'keywords',
    ]) {
      expect(claude[field], field).toEqual(portable[field]);
    }
  });

  // Issue #25: measured live against Codex CLI 0.146.0 — `codex plugin marketplace add`
  // and `codex plugin add` read this exact file, the same `.claude-plugin/` convention
  // Claude Code uses. There is no second, Codex-specific manifest format to ship; this
  // locks the one file working for both harnesses so a future edit that breaks the
  // shape Codex expects (a `plugins[].source` Codex can't resolve, a missing `name`)
  // fails here instead of silently in the field.
  it('doubles as the Codex plugin manifest — one marketplace.json, both harnesses', () => {
    const marketplace = JSON.parse(readFileSync(resolve('.claude-plugin/marketplace.json'), 'utf-8')) as {
      name: string;
      plugins: readonly { name: string; source: string; description: string }[];
    };

    expect(marketplace.name).toBe('mehmory');
    expect(marketplace.plugins).toHaveLength(1);
    const [plugin] = marketplace.plugins;
    expect(plugin?.name).toBe('mehmory');
    // A relative path Codex resolves against the marketplace root it was pointed at,
    // not an absolute path or a URL — this is the shape `codex plugin add` accepted
    // when this was measured.
    expect(plugin?.source).toBe('./');
    expect(plugin?.description.length ?? 0).toBeGreaterThan(20);
  });
});
