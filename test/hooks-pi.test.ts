import { changeSession } from './session-fixture.js';
/**
 * Pi host end-to-end through the built bundles, invoked exactly as the Pi extension
 * invokes them: `argv[2] === 'pi'` and a payload carrying `session_id`,
 * `transcript_path` (the Pi session file), `cwd` and `hook_event_name`.
 *
 * Same store, same project key, same inbox as the other harnesses — only the reader,
 * the skill wording, the approved transcript root and the `host=` attribution differ.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { createTempDir, hermeticEnv } from './helpers.js';
import {
  additionalContext,
  keyFor,
  outputJson,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writePiSession,
  TODAY,
} from './hook-fixture.js';
import { setPaused } from '../src/core/session.js';
import { loadConfig } from '../src/core/config.js';
import { parseInboxEntries } from '../src/schema/format.js';

const PI_ARGS = ['pi'] as const;

const PI_SESSION = 'dd000000-0000-4000-8000-00000000pi01';

const DEPLOY_PAGE = `---
updated: ${TODAY}
type: procedure
---

# Deployment runbook

- deployment runs through the fly.io pipeline
`;

const SESSION_MESSAGES = [
  { text: 'We decided to use fly.io for deploys.' },
  { text: 'Noted, fly.io it is.', role: 'assistant' as const },
  {
    text: '<skill name="remember" location="/x/skills/remember/SKILL.md">\nThe skill body says nothing about kubernetes.\n</skill>\n\nstaging deploys need the VPN',
  },
];

function payload(
  event: string,
  cwd: string,
  transcriptPath: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: PI_SESSION,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: event,
    ...extra,
  };
}

function primeCounter(): void {
  const threshold = loadConfig().stop.capture_threshold;
  changeSession(PI_SESSION, (state) => ({ ...state, stop_count: threshold - 1 }));
}

describe('Pi host through the hook bundles', () => {
  let cwd: string;
  let key: string;
  let session: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, { pages: { 'deployment.md': DEPLOY_PAGE } });
    session = writePiSession(SESSION_MESSAGES, PI_SESSION);
  });

  it('injects the memory frame at session start, attributed to pi', () => {
    const run = runHook(
      'session-start',
      payload('SessionStart', cwd, session, { source: 'startup' }),
      {
        cwd,
        args: PI_ARGS,
      }
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(additionalContext(run)).toContain(`# project ${key}`);
    expect(statsLines().at(-1)).toMatchObject({ hook: 'SessionStart', host: 'pi' });
  });

  it('names the Pi skill command in its maintenance lines', () => {
    seedStore(key, { inboxEntries: 30 });

    const context = additionalContext(
      runHook('session-start', payload('SessionStart', cwd, session, { source: 'compact' }), {
        cwd,
        args: PI_ARGS,
      })
    );

    expect(context).toContain('/skill:integrate');
    expect(context).not.toContain('/mehmory:');
    expect(context).not.toContain('mehmory-integrate');
  });

  it('captures the `remember:` prefix inline, attributed to pi', () => {
    const run = runHook(
      'user-prompt-submit',
      payload('UserPromptSubmit', cwd, session, { prompt: 'remember: the cache is per-tenant' }),
      { cwd, args: PI_ARGS }
    );

    expect(additionalContext(run)).toBe('mehmory: captured to inbox');
    expect(parseInboxEntries(readIfPresent(paths(key).inbox))).toMatchObject([
      { text: 'the cache is per-tenant', src: PI_SESSION, host: 'pi' },
    ]);
  });

  it('distills the Pi session file at the stop threshold into the same inbox', () => {
    primeCounter();

    const run = runHook('stop', payload('Stop', cwd, session), { cwd, args: PI_ARGS });

    expect(run.status).toBe(0);
    const entries = parseInboxEntries(readIfPresent(paths(key).inbox));
    expect(entries.map((entry) => [entry.text, entry.host])).toEqual([
      ['We decided to use fly.io for deploys.', 'pi'],
      ['staging deploys need the VPN', 'pi'],
    ]);
    expect(statsLines().at(-1)).toMatchObject({ hook: 'Stop', host: 'pi', captured_entries: 2 });
  });

  it('nudges in the context shape, naming /skill:remember and an inbox-tx command that runs', () => {
    primeCounter();

    const run = runHook('stop', payload('Stop', cwd, session), { cwd, args: PI_ARGS });

    // The context shape, never `{decision, reason}`: the Pi extension reads
    // `additionalContext` and turns it into a custom message.
    expect(Object.keys(outputJson(run))).toEqual(['hookSpecificOutput']);
    const reason = additionalContext(run);
    expect(reason).toContain('Use /skill:remember, or run:');

    const match = /node ['"]?[^'"\n]*inbox-tx\.mjs['"]? append <<'JSON'\n[\s\S]*?\nJSON\n/.exec(
      reason
    );
    expect(match).not.toBeNull();
    const learning = "pi's session dir is per-cwd";
    const command = String(match?.[0]).replace('<the learning>', learning);
    const tx = spawnSync('sh', ['-c', command], { env: hermeticEnv(), encoding: 'utf-8' });

    expect(tx.stderr).toBe('');
    expect(JSON.parse(tx.stdout)).toMatchObject({ appended: 1 });
    expect(readIfPresent(paths(key).inbox)).toContain(learning);
  });

  it('refuses a session file outside the Pi session root unless PI_CODING_AGENT_SESSION_DIR names it', () => {
    const elsewhere = createTempDir('mehmory-pi-elsewhere');
    const outside = join(elsewhere, 'session.jsonl');
    copyFileSync(session, outside);

    primeCounter();
    runHook('stop', payload('Stop', cwd, outside), { cwd, args: PI_ARGS });
    expect(parseInboxEntries(readIfPresent(paths(key).inbox))).toEqual([]);

    primeCounter();
    runHook('stop', payload('Stop', cwd, outside), {
      cwd,
      args: PI_ARGS,
      env: { PI_CODING_AGENT_SESSION_DIR: elsewhere },
    });
    expect(parseInboxEntries(readIfPresent(paths(key).inbox)).map((entry) => entry.text)).toEqual([
      'We decided to use fly.io for deploys.',
      'staging deploys need the VPN',
    ]);
  });

  it('suppresses injection and capture while paused', () => {
    setPaused(PI_SESSION, true);
    primeCounter();

    const start = runHook(
      'session-start',
      payload('SessionStart', cwd, session, { source: 'startup' }),
      {
        cwd,
        args: PI_ARGS,
      }
    );
    const remember = runHook(
      'user-prompt-submit',
      payload('UserPromptSubmit', cwd, session, { prompt: 'remember: must not be captured' }),
      { cwd, args: PI_ARGS }
    );
    const stop = runHook('stop', payload('Stop', cwd, session), { cwd, args: PI_ARGS });

    expect([start.stdout, remember.stdout, stop.stdout]).toEqual(['', '', '{}']);
    expect(readIfPresent(paths(key).inbox)).toBe('');
  });
});
