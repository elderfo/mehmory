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

const SKILLS = ['integrate', 'lint', 'onboard-session', 'remember', 'pause', 'resume'];

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
    expect(fields['description']?.length).toBeGreaterThan(40);
    expect(fields['allowed-tools']?.length).toBeGreaterThan(0);
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

  it('every bundled script a SKILL.md references exists after the build', () => {
    const referenced = new Set<string>();
    for (const body of bodies.values()) {
      for (const m of body.matchAll(/hooks\/([A-Za-z0-9._-]+\.mjs)/g)) {
        if (m[1]) referenced.add(m[1]);
      }
    }
    // A skill set that references nothing would pass vacuously; integrate must use one.
    expect(referenced).toContain('inbox-tx.mjs');
    for (const script of referenced) {
      expect(existsSync(resolve('hooks', script)), `hooks/${script} missing — run pnpm build`).toBe(
        true
      );
    }
  });
});

describe('plugin manifest', () => {
  it('parses, is named mehmory, and tracks the package version', () => {
    const manifest = JSON.parse(readFileSync(resolve('.claude-plugin/plugin.json'), 'utf-8')) as {
      name: string;
      version: string;
      description: string;
    };
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string };

    expect(manifest.name).toBe('mehmory');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description.length).toBeGreaterThan(20);
  });
});
