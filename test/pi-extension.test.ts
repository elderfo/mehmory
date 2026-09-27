/**
 * The built Pi extension (`hooks/pi-extension.mjs`), driven the way Pi drives it: the
 * default export receives an API whose `on` collects handlers, and each handler is
 * called with an event and a ctx whose `sessionManager` points at a real session file.
 * The handlers spawn the real hook bundles, so every assertion is end to end.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, PI_SESSION_ENV } from './helpers.js';
import {
  HOOKS_DIR,
  keyFor,
  paths,
  readIfPresent,
  seedStore,
  statsLines,
  writePiSession,
} from './hook-fixture.js';
import { updateSessionState } from '../src/core/session.js';
import { loadConfig } from '../src/core/config.js';
import { parseInboxEntries } from '../src/schema/format.js';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

interface ExtensionModule {
  default: (pi: unknown) => void;
  hookOutputText: (stdout: string) => string;
  hookPayload: (hook: string, session: Record<string, unknown>) => Record<string, unknown>;
}

const PI_SESSION = 'dd000000-0000-4000-8000-00000000pi02';

const DEPLOY_PAGE = `---
updated: 2026-07-01
type: procedure
---

# Deployment runbook

- deployment runs through the fly.io pipeline
`;

async function loadExtension(): Promise<ExtensionModule> {
  return (await import(pathToFileURL(join(HOOKS_DIR, 'pi-extension.mjs')).href)) as ExtensionModule;
}

/** Register the extension on a fake Pi and return its handlers by event name. */
async function register(): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  (await loadExtension()).default({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

function fire(handlers: Map<string, Handler>, event: string, payload: unknown, ctx: unknown): Promise<unknown> {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler registered for ${event}`);
  return handler(payload, ctx);
}

function primeCounter(): void {
  const threshold = loadConfig().stop.capture_threshold;
  updateSessionState(PI_SESSION, state => ({ ...state, stop_count: threshold - 1 }));
}

describe('Pi extension', () => {
  const saved = new Map<string, string | undefined>();
  let cwd: string;
  let key: string;
  let ctx: Record<string, unknown>;

  beforeEach(() => {
    // The extension spawns hooks with this process's env, so make it the hermetic one:
    // the temp store as HOME, and no Pi variables inherited from a Pi-hosted test run.
    for (const name of ['HOME', 'PATH', ...PI_SESSION_ENV]) saved.set(name, process.env[name]);
    process.env['HOME'] = process.env['MEHMORY_HOME'];
    for (const name of PI_SESSION_ENV) Reflect.deleteProperty(process.env, name);

    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, { pages: { 'deployment.md': DEPLOY_PAGE } });
    const file = writePiSession([{ text: 'We decided to use fly.io for deploys.' }], PI_SESSION);
    ctx = {
      cwd,
      sessionManager: {
        getSessionId: () => PI_SESSION,
        getSessionFile: () => file,
        getSessionDir: () => dirname(file),
      },
    };
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  });

  it('delivers the SessionStart frame on the first prompt only', async () => {
    const handlers = await register();

    expect(await fire(handlers, 'session_start', { type: 'session_start', reason: 'startup' }, ctx)).toBeUndefined();
    const first = (await fire(handlers, 'before_agent_start', { prompt: 'hello' }, ctx)) as {
      message: { customType: string; content: string; display: boolean };
    };
    const second = await fire(handlers, 'before_agent_start', { prompt: 'hello' }, ctx);

    expect(first.message.customType).toBe('mehmory');
    expect(first.message.display).toBe(false);
    expect(first.message.content).toContain(`# project ${key}`);
    expect(second).toBeUndefined();
    expect(statsLines().map(line => [line['hook'], line['host']])).toEqual([
      ['SessionStart', 'pi'],
      ['UserPromptSubmit', 'pi'],
      ['UserPromptSubmit', 'pi'],
    ]);
  });

  it('joins pointers to the pending frame, and strips a skill envelope before capture', async () => {
    const handlers = await register();

    await fire(handlers, 'session_start', { reason: 'resume' }, ctx);
    const pointed = (await fire(handlers, 'before_agent_start', { prompt: 'how does deployment work?' }, ctx)) as {
      message: { content: string };
    };
    expect(pointed.message.content).toContain(`# project ${key}`);
    expect(pointed.message.content).toContain('relevant: pages/deployment.md');

    await fire(
      handlers,
      'before_agent_start',
      {
        prompt:
          '<skill name="remember" location="/x/SKILL.md">\nremember: the body is not the user\n</skill>\n\nremember: staging needs the VPN',
      },
      ctx
    );
    expect(parseInboxEntries(readIfPresent(paths(key).inbox)).map(entry => [entry.text, entry.host])).toEqual([
      ['staging needs the VPN', 'pi'],
    ]);
  });

  it('does nothing on a runtime reload', async () => {
    const handlers = await register();

    await fire(handlers, 'session_start', { reason: 'reload' }, ctx);
    await fire(handlers, 'session_shutdown', { reason: 'reload' }, ctx);

    expect(statsLines()).toEqual([]);
  });

  it('re-injects the frame after compaction', async () => {
    const handlers = await register();

    await fire(handlers, 'session_before_compact', { reason: 'threshold' }, ctx);
    await fire(handlers, 'session_compact', { reason: 'threshold' }, ctx);
    const next = (await fire(handlers, 'before_agent_start', { prompt: 'hello' }, ctx)) as {
      message: { content: string };
    };

    expect(next.message.content).toContain(`# project ${key}`);
    expect(statsLines().map(line => line['hook'])).toEqual(['PreCompact', 'SessionStart', 'UserPromptSubmit']);
  });

  it('nudges once at the threshold and lets the guarded settle through', async () => {
    const handlers = await register();
    primeCounter();

    const nudge = (await fire(handlers, 'agent_before_settle', { outcome: 'completed' }, ctx)) as {
      entries: { type: string; customType: string; content: string; display: boolean }[];
      continue: boolean;
    };
    const guarded = await fire(handlers, 'agent_before_settle', { outcome: 'completed' }, ctx);
    const next = await fire(handlers, 'agent_before_settle', { outcome: 'completed' }, ctx);

    expect(nudge.continue).toBe(true);
    expect(nudge.entries).toHaveLength(1);
    expect(nudge.entries[0]).toMatchObject({ type: 'custom_message', customType: 'mehmory', display: true });
    expect(nudge.entries[0]?.content).toContain('Use /skill:remember, or run:');
    expect(guarded).toBeUndefined();
    expect(next).toBeUndefined();
    // The guarded settle did not count; the one after it is the first of the next stretch.
    expect(statsLines().at(-1)).toMatchObject({ hook: 'Stop', host: 'pi', stop_count: 1 });
    expect(parseInboxEntries(readIfPresent(paths(key).inbox)).map(entry => entry.text)).toEqual([
      'We decided to use fly.io for deploys.',
    ]);
  });

  it('ignores a settle that did not complete', async () => {
    const handlers = await register();
    primeCounter();

    expect(await fire(handlers, 'agent_before_settle', { outcome: 'aborted' }, ctx)).toBeUndefined();
    expect(await fire(handlers, 'agent_before_settle', { outcome: 'error' }, ctx)).toBeUndefined();
    expect(statsLines()).toEqual([]);
  });

  it('runs session-end on quit', async () => {
    const handlers = await register();

    await fire(handlers, 'session_shutdown', { reason: 'quit' }, ctx);

    expect(statsLines().map(line => [line['hook'], line['host']])).toEqual([['SessionEnd', 'pi']]);
  });

  it('never rejects: node missing, garbage events, a broken ctx, a broken pi', async () => {
    const module = await loadExtension();
    expect(() => {
      module.default(null);
      module.default({});
      module.default({
        on: () => {
          throw new Error('refused');
        },
      });
    }).not.toThrow();

    const handlers = await register();
    const throwing = {
      cwd,
      sessionManager: {
        getSessionId: () => {
          throw new Error('stale ctx');
        },
      },
    };
    const rejections: string[] = [];
    for (const [event, handler] of handlers) {
      // A ctx that names no session: nothing to run, so nothing comes back.
      await expect(handler({ reason: 'startup', outcome: 'completed' }, null), event).resolves.toBeUndefined();
      await expect(handler({ reason: 'startup', outcome: 'completed' }, throwing), event).resolves.toBeUndefined();
      // A garbage event on a real session may still run a hook; it must never reject.
      for (const payload of [null, 'garbage', { reason: 42, outcome: 'completed', prompt: 7 }]) {
        await handler(payload, ctx).catch((err: unknown) => rejections.push(`${event}: ${String(err)}`));
      }
    }
    expect(rejections).toEqual([]);

    process.env['PATH'] = createTempDir('mehmory-empty-path');
    primeCounter();
    await expect(fire(handlers, 'session_start', { reason: 'startup' }, ctx)).resolves.toBeUndefined();
    await expect(fire(handlers, 'agent_before_settle', { outcome: 'completed' }, ctx)).resolves.toBeUndefined();
    await expect(fire(handlers, 'before_agent_start', { prompt: 'hello' }, ctx)).resolves.toBeUndefined();
  });
});

describe('Pi extension mapping', () => {
  it('reads context, a block reason, or nothing out of hook stdout', async () => {
    const { hookOutputText } = await loadExtension();

    expect(
      [
        '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"save it"}}',
        '{"decision":"block","reason":"blocked"}',
        '{}',
        '',
        'not json',
        '[1,2]',
        '{"decision":"approve","reason":"no"}',
      ].map(hookOutputText)
    ).toEqual(['save it', 'blocked', '', '', '', '', '']);
  });

  it('omits transcript_path when Pi keeps no session file', async () => {
    const { hookPayload } = await loadExtension();

    expect(hookPayload('stop', { id: 's1', cwd: '/w' })).toEqual({
      session_id: 's1',
      cwd: '/w',
      hook_event_name: 'Stop',
    });
    expect(hookPayload('session-start', { id: 's1', cwd: '/w', file: '/w/s.jsonl' })).toEqual({
      session_id: 's1',
      transcript_path: '/w/s.jsonl',
      cwd: '/w',
      hook_event_name: 'SessionStart',
    });
  });
});

describe('Pi package manifest', () => {
  it('names the built extension and a skills directory that Pi can load', async () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      keywords: string[];
      pi: { extensions: string[]; skills: string[] };
    };

    expect(manifest.keywords).toContain('pi-package');
    expect(manifest.pi.extensions).toEqual(['./hooks/pi-extension.mjs']);
    const extension = (await import(pathToFileURL(join(process.cwd(), manifest.pi.extensions[0] ?? '')).href)) as {
      default: unknown;
    };
    expect(typeof extension.default).toBe('function');
    for (const dir of manifest.pi.skills) {
      expect(existsSync(join(dir, 'remember', 'SKILL.md')), dir).toBe(true);
    }
  });
});
