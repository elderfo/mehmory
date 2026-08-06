/** hooks/hooks.json registration and bundle self-containment (criterion 3, hooks half). */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, hermeticEnv } from './helpers.js';
import { HOOKS_DIR } from './hook-fixture.js';

interface HookCommand {
  type: string;
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

const EXPECTED: Record<string, { matcher?: string; script: string; host: string }> = {
  SessionStart: { matcher: 'startup|resume|compact', script: 'session-start.mjs', host: 'claude-code' },
  UserPromptSubmit: { script: 'user-prompt-submit.mjs', host: 'claude-code' },
  Stop: { script: 'stop.mjs', host: 'claude-code' },
  PreCompact: { script: 'pre-compact.mjs', host: 'claude-code' },
  SessionEnd: { script: 'session-end.mjs', host: 'claude-code' },
};

function readRegistry(): Record<string, HookMatcher[]> {
  const raw = readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { hooks: Record<string, HookMatcher[]> };
  return parsed.hooks;
}

describe('plugin hooks layout', () => {
  it('registers exactly the five hooks with the expected events', () => {
    const registry = readRegistry();
    expect(Object.keys(registry).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('points every registration at a bundled .mjs under CLAUDE_PLUGIN_ROOT', () => {
    const registry = readRegistry();

    for (const [event, expected] of Object.entries(EXPECTED)) {
      const matchers = registry[event];
      expect(matchers, event).toHaveLength(1);
      const entry = matchers?.[0];
      expect(entry?.matcher, event).toBe(expected.matcher);
      expect(entry?.hooks, event).toHaveLength(1);
      expect(entry?.hooks[0]?.type, event).toBe('command');
      expect(entry?.hooks[0]?.command, event).toBe(
        `node \${CLAUDE_PLUGIN_ROOT}/hooks/${expected.script} ${expected.host}`
      );
      expect(existsSync(join(HOOKS_DIR, expected.script)), expected.script).toBe(true);
    }
  });

  it('commits every bundle to git, so a marketplace clone of the branch has them', () => {
    // The one assertion that would have caught the 0.3.0 outage. `existsSync` above is
    // satisfied by any local `pnpm build`, but the plugin marketplace does not build —
    // it clones this repo's default branch and copies the tree. While `/hooks/*.mjs`
    // was gitignored, every installed plugin got a hooks.json registering five commands
    // whose files were absent, and all five hooks died with MODULE_NOT_FOUND. Tracked-ness
    // is the real contract; presence on disk is not (A25 in docs/WORLD_MODEL.md).
    const tracked = spawnSync('git', ['ls-files', '--', 'hooks/*.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    expect(tracked.status, tracked.stderr).toBe(0);
    const trackedNames = new Set(
      tracked.stdout
        .split('\n')
        .filter(Boolean)
        .map(p => p.slice('hooks/'.length))
    );

    // Every .mjs the build emits, not just the five entrypoints: the entrypoints import
    // shared `chunk-*.mjs` siblings, so an untracked chunk breaks them just as completely.
    const onDisk = readdirSync(HOOKS_DIR).filter(f => f.endsWith('.mjs'));
    expect(onDisk.length).toBeGreaterThan(0);
    for (const file of onDisk) {
      expect(trackedNames.has(file), `hooks/${file} is not tracked by git`).toBe(true);
    }
  });

  it('runs each bundle standalone from outside the repo', () => {
    // Copied out of the tree entirely: nothing resolves through the repo's node_modules.
    const elsewhere = createTempDir('mehmory-plugin-root');
    cpSync(HOOKS_DIR, elsewhere, { recursive: true });

    for (const { script } of Object.values(EXPECTED)) {
      const result = spawnSync(process.execPath, [join(elsewhere, script)], {
        input: '{"session_id":"standalone"}',
        env: hermeticEnv(),
        encoding: 'utf-8',
        cwd: elsewhere,
      });
      expect(result.stderr, script).toBe('');
      expect(result.status, script).toBe(0);
    }
  });
});
