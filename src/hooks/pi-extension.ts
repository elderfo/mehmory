/**
 * Pi extension: Pi's equivalent of `hooks.json` (A29).
 *
 * Pi has no command-hook configuration, only in-process extensions, so this module is
 * the hook runner: it listens to Pi's lifecycle events and spawns the SAME five hook
 * bundles every other harness runs, with `pi` as the host argument (A12, A23). Nothing
 * here reimplements a hook; it only maps Pi events to hook payloads and hook output back
 * to Pi results.
 *
 * Unlike its siblings it is not a `runHook` entrypoint. Pi imports it and calls the
 * default export; run as a plain script it does nothing and exits 0.
 *
 * Every Pi value is untrusted here (the extension API is not a dependency, only a
 * structural shape), and every failure is silence: nothing may throw into Pi (A2).
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripPiSkillEnvelope } from '../transcript/pi.js';

/** Directory this bundle runs from; the five hook bundles are its siblings. */
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/** A hook past this is killed and treated as silence, so Pi never waits on a wedged store. */
const HOOK_TIMEOUT_MS = 10_000;

/** The hook bundles, by `.mjs` name, and the event name each reports. */
const HOOK_EVENTS = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  stop: 'Stop',
  'pre-compact': 'PreCompact',
  'session-end': 'SessionEnd',
} as const;

export type PiHook = keyof typeof HOOK_EVENTS;

/** The subset of Pi's `ExtensionAPI` this module uses. */
interface PiApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>): unknown;
}

/** What identifies the running Pi session, narrowed from the handler's `ctx`. */
export interface PiSession {
  readonly id: string;
  readonly cwd: string;
  /** Undefined under `--no-session`. */
  readonly file?: string;
  readonly dir?: string;
}

/** Per-runtime state. Pi builds a fresh runtime per session, so this never outlives one. */
interface RuntimeState {
  /** SessionStart output waiting to ride the next prompt. */
  pendingContext: string;
  /** Stop loop guard: true while the model is answering our own nudge. */
  nudged: boolean;
}

/** `customType` on every message mehmory adds to a Pi session. */
const CUSTOM_TYPE = 'mehmory';

// ─── Pure: Pi values in, hook values out ───

/** Narrow a handler `ctx` to the session it describes, or undefined when it has none. */
export function piSession(ctx: unknown): PiSession | undefined {
  const record = asRecord(ctx);
  const manager = asRecord(record?.['sessionManager']);
  const cwd = record?.['cwd'];
  if (!manager || typeof cwd !== 'string') return undefined;

  const id = call(manager, 'getSessionId');
  if (typeof id !== 'string' || !id) return undefined;
  const file = call(manager, 'getSessionFile');
  const dir = call(manager, 'getSessionDir');
  return {
    id,
    cwd,
    ...(typeof file === 'string' && file ? { file } : {}),
    ...(typeof dir === 'string' && dir ? { dir } : {}),
  };
}

/** The stdin payload for `hook`, in the shape every hook bundle parses. */
export function hookPayload(
  hook: PiHook,
  session: PiSession,
  fields: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    session_id: session.id,
    ...(session.file === undefined ? {} : { transcript_path: session.file }),
    cwd: session.cwd,
    hook_event_name: HOOK_EVENTS[hook],
    ...fields,
  };
}

/**
 * The SessionStart `source` for a Pi `session_start` reason, or undefined when no hook
 * should run. `reload` rebuilds the runtime for the same session, whose earlier
 * injection is already persisted in it.
 */
export function sessionStartSource(reason: unknown): 'startup' | 'resume' | undefined {
  if (reason === 'reload') return undefined;
  return reason === 'resume' || reason === 'fork' ? 'resume' : 'startup';
}

/**
 * The text a hook wants the model to see: `additionalContext`, or a block `reason`.
 * Anything else, `{}` and garbage included, is silence.
 */
export function hookOutputText(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return '';
  }
  const record = asRecord(parsed);
  const context = asRecord(record?.['hookSpecificOutput'])?.['additionalContext'];
  if (typeof context === 'string') return context;
  const reason = record?.['reason'];
  return record?.['decision'] === 'block' && typeof reason === 'string' ? reason : '';
}

// ─── Shell: spawn a bundle, never throw ───

/** Run one hook bundle and return the text it produced, '' on any failure. */
function runHook(hook: PiHook, session: PiSession, fields: Readonly<Record<string, unknown>> = {}): Promise<string> {
  return new Promise(resolve => {
    try {
      // `node` from PATH, as `hooks.json` does: Pi itself may be running under bun.
      const child = spawn('node', [join(HOOK_DIR, `${hook}.mjs`), 'pi'], {
        // Transcript approval follows `--session-dir`, which only Pi knows about.
        env: session.dir === undefined ? process.env : { ...process.env, PI_CODING_AGENT_SESSION_DIR: session.dir },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('');
      }, HOOK_TIMEOUT_MS);
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(hookOutputText(stdout));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(hookPayload(hook, session, fields)));
    } catch {
      resolve('');
    }
  });
}

// ─── Wiring ───

/**
 * Register mehmory's handlers on a Pi extension API.
 *
 * Injection rides `before_agent_start`, not `session_start`: Pi creates the session file
 * lazily and has no prompt to attach a message to until the first one arrives.
 */
export default function mehmory(pi: unknown): void {
  const api = asRecord(pi);
  if (typeof api?.['on'] !== 'function') return;
  const on = (event: string, handler: (event: Record<string, unknown>, session: PiSession) => Promise<unknown>): void => {
    try {
      (api as unknown as PiApi).on(event, async (raw, ctx) => {
        try {
          const session = piSession(ctx);
          return session === undefined ? undefined : await handler(asRecord(raw) ?? {}, session);
        } catch {
          return undefined;
        }
      });
    } catch {
      // A Pi that refuses a registration simply does not get that handler.
    }
  };

  const state: RuntimeState = { pendingContext: '', nudged: false };

  on('session_start', async (event, session) => {
    const source = sessionStartSource(event['reason']);
    if (source === undefined) return undefined;
    state.pendingContext = await runHook('session-start', session, { source });
    return undefined;
  });

  on('before_agent_start', async (event, session) => {
    const prompt = typeof event['prompt'] === 'string' ? stripPiSkillEnvelope(event['prompt']) : '';
    const submitted = await runHook('user-prompt-submit', session, { prompt });
    const content = [state.pendingContext, submitted].filter(Boolean).join('\n');
    state.pendingContext = '';
    return content ? { message: { customType: CUSTOM_TYPE, content, display: false } } : undefined;
  });

  // Pi's Stop: `continue` re-invokes the model once, and the settle that follows carries
  // `nudged` as `stop_hook_active`, so the nudge cannot loop.
  on('agent_before_settle', async (event, session) => {
    if (event['outcome'] !== 'completed') return undefined;
    const reason = await runHook('stop', session, { stop_hook_active: state.nudged });
    state.nudged = reason !== '';
    return reason
      ? {
          entries: [{ type: 'custom_message', customType: CUSTOM_TYPE, content: reason, display: true }],
          continue: true,
        }
      : undefined;
  });

  // Never cancels: returning nothing lets Pi compact as it would have.
  on('session_before_compact', async (_event, session) => {
    await runHook('pre-compact', session);
    return undefined;
  });

  // Compaction dropped the earlier injection, so the next prompt carries it again.
  on('session_compact', async (_event, session) => {
    state.pendingContext = await runHook('session-start', session, { source: 'compact' });
    return undefined;
  });

  on('session_shutdown', async (event, session) => {
    if (event['reason'] === 'reload') return undefined;
    await runHook('session-end', session);
    return undefined;
  });
}

/** Call a zero-argument method on an untrusted object; any failure is undefined. */
function call(target: Record<string, unknown>, method: string): unknown {
  const fn = target[method];
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as () => unknown).call(target);
  } catch {
    return undefined;
  }
}

/** Narrow an unknown value to an object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
