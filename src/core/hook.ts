/**
 * Hook entrypoint plumbing (A12): stdin JSON in, stdout JSON out, always exit 0.
 *
 * Every `src/hooks/*.ts` file is `runHook('<Event>', (input, project, host, config) => …)` and
 * nothing else. This module owns the parts that are identical across all five: reading
 * stdin, resolving the project key, timing the invocation, writing the stats line, and
 * swallowing every error so a broken memory store can never break a session (A2, U8).
 */

import { readStdin } from './fs.js';
import { logError } from './errors.js';
import { resolveProjectKey } from './identity.js';
import { recordStat } from './stats.js';
import { resolveHost, type Host } from './host.js';
import { loadConfig, type MehmoryConfig } from './config.js';
import { rememberSessionOrigin } from './session.js';

/** The fields Claude Code puts on hook stdin. All optional but `session_id`. */
export interface HookInput {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  /** SessionStart only: `startup` | `resume` | `compact`. */
  readonly source?: string;
  /** UserPromptSubmit only: the raw prompt text. */
  readonly prompt?: string;
  /** Stop only: true when this Stop was itself triggered by a hook block. */
  readonly stop_hook_active?: boolean;
}

/** What a hook body hands back. Everything is optional — silence is a valid result. */
export interface HookResult {
  /** Text surfaced to the model as `additionalContext`. */
  readonly context?: string;
  /** A raw output object (Stop's `{decision, reason}`), emitted instead of context. */
  readonly json?: Readonly<Record<string, unknown>>;
  /** Extra fields merged into this invocation's stats line (criterion 16). */
  readonly stats?: Readonly<Record<string, unknown>>;
}

/** Parse a hook stdin payload. Anything unparseable yields an empty input. */
export function parseHookInput(raw: string): HookInput {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { session_id: '' };
    const v = parsed as Record<string, unknown>;
    const str = (name: string): string | undefined =>
      typeof v[name] === 'string' ? v[name] : undefined;
    return {
      session_id: str('session_id') ?? '',
      ...(str('transcript_path') !== undefined ? { transcript_path: str('transcript_path') } : {}),
      ...(str('hook_event_name') !== undefined ? { hook_event_name: str('hook_event_name') } : {}),
      ...(str('cwd') !== undefined ? { cwd: str('cwd') } : {}),
      ...(str('source') !== undefined ? { source: str('source') } : {}),
      ...(str('prompt') !== undefined ? { prompt: str('prompt') } : {}),
      ...(v['stop_hook_active'] === true ? { stop_hook_active: true } : {}),
    };
  } catch {
    return { session_id: '' };
  }
}

/**
 * Serialize a result into the bytes the harness expects on stdout ('' for silence).
 *
 * Stop is the exception, and gets `{}` rather than silence. Codex's Stop output was
 * measured (`VERDICT.md`) to accept `{}` and `{decision, reason}` and to reject the
 * `hookSpecificOutput` envelope that is valid on every other event — but silence was
 * never exercised there, and a harness that parses Stop output unconditionally would
 * surface an error on the most frequent path in the integration: the below-threshold
 * Stop. `{}` removes that unknown instead of trading it for another, since `{}` is the
 * documented no-op on Claude Code too (A2, A8).
 */
export function renderHookOutput(event: string, result: HookResult): string {
  if (result.json) return JSON.stringify(result.json);
  if (!result.context) return event === 'Stop' ? '{}' : '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: result.context },
  });
}

/**
 * Run one hook body under the fail-open contract.
 *
 * Errors never reach stderr and never change the exit code (U2, U8): they land in
 * `errors.log`, become a pending warning, and the hook produces no output. The stats
 * line is written even for a failed invocation — a hook that dies every time is
 * exactly what the instrumentation exists to make visible.
 *
 * The invoking harness travels as `process.argv[2]` — each `hooks.json`/config the
 * plugin writes passes it explicitly (A23) — resolved once here via `resolveHost`,
 * checked against `config.hosts.<host>.enabled` (the per-harness capture toggle,
 * issue #25), recorded on the stats line, and handed to the body as an argument so
 * nothing below has to read it ambiently (A21). The config loaded to evaluate that
 * toggle is the same object handed to `body` — an adapter reading `loadConfig()` again
 * would not only cost a second disk read on every invocation, it could disagree with
 * the toggle this function just checked. A disabled harness skips `body` entirely — no
 * stdin is read, so there is no capture, no injection and no pointer, the same silence
 * `/mehmory:pause` promises for a single session, but persistent and scoped to one
 * harness via config instead.
 *
 * @param event - Hook event name, e.g. `SessionStart`
 * @param body - The hook itself; receives parsed stdin, the project key, the host, and
 *   the already-loaded config
 */
export function runHook(
  event: string,
  body: (_input: HookInput, _project: string, _host: Host, _config: MehmoryConfig) => HookResult
): void {
  const started = Date.now();
  const host = resolveHost(process.argv[2]);
  const config = loadConfig();
  let result: HookResult = {};
  let project = 'unknown';

  try {
    if (config.hosts[host].enabled) {
      const input = parseHookInput(readStdin());
      project = resolveProjectKey(input.cwd ?? process.cwd());
      // Every hook body reaches for session state, and `.state/<id>.json` with an empty
      // id is `.state/.json` — one shared file every malformed invocation would pollute.
      // No session id, no session: log it and stay silent (A2).
      if (input.session_id.trim() === '') {
        logError({
          code: 'E_SESSION_STATE',
          kind: 'informational',
          what: `${event} hook received no session_id`,
          consequence: 'The invocation was skipped; no session state was read or written',
        });
      } else {
        // Where this session's material lives and who wrote it, so the next session start
        // can finalize it even if this session never reports an end (issue #24).
        rememberSessionOrigin(input.session_id, input.transcript_path, host);
        result = body(input, project, host, config);
      }
    }
  } catch (err) {
    try {
      // Informational, not actionable: there is no command that fixes an arbitrary
      // hook exception, and the old `fix` merely restated the `Details: <errors.log>`
      // clause `formatUserError` already appends (U10 / run-1 amendment 16).
      logError({
        code: 'E_APPEND_FAILED',
        kind: 'informational',
        what: `${event} hook failed: ${err instanceof Error ? err.message : String(err)}`,
        consequence: 'This hook produced no output; the session is unaffected',
      });
    } catch {
      // The store itself is unwritable. Nothing left to do but stay silent.
    }
    result = {};
  }

  try {
    recordStat({ project, hook: event, host, ms: Date.now() - started, ...result.stats });
  } catch {
    // Instrumentation must never be the thing that breaks a hook.
  }

  const out = renderHookOutput(event, result);
  if (out) process.stdout.write(out);
}
