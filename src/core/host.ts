/**
 * Which harness invoked this hook (A21, A23): declared by the hook configuration as an
 * explicit argument, resolved here, and threaded to callers — never read ambiently deep
 * in the call graph. Environment detection is a fallback for a hand-written
 * configuration that has not been updated to pass the argument yet.
 */

/** The harness a hook invocation runs under. Free-form: a new harness's own value
 * passes straight through without any change to this module. */
export type Host = string;

/** Value used when nothing else identifies the host — the only harness before #18. */
export const DEFAULT_HOST: Host = 'claude-code';

/**
 * Resolve which harness invoked this hook.
 *
 * `arg` is the explicit host every hook command now carries (`hooks.json` passes it on
 * the command line) — authoritative whenever present, since mehmory writes every hook
 * configuration itself and can always declare rather than infer (A23). Falls back to
 * environment detection only for a hand-written configuration that omits it, and never
 * fails the hook (A2): an empty or missing argument still resolves to something usable.
 */
export function resolveHost(arg: string | undefined): Host {
  const trimmed = arg?.trim();
  if (trimmed) return trimmed;
  return detectHostFromEnvironment();
}

/**
 * Best-effort environment probe, used only when no host argument was passed.
 *
 * `CLAUDE_PLUGIN_ROOT` is the one signal Claude Code puts around every hook command
 * today (`hooks.json` references it directly) — good enough for a fallback that exists
 * purely to keep an un-updated configuration working, never for routing logic.
 */
function detectHostFromEnvironment(): Host {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  return DEFAULT_HOST;
}
