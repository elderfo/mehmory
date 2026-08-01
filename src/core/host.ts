/**
 * Which harness invoked this hook (A21, A23): declared by the hook configuration as an
 * explicit argument, resolved here, and threaded to callers — never read ambiently deep
 * in the call graph. Environment detection is a fallback for a hand-written
 * configuration that has not been updated to pass the argument yet.
 */

import { INBOX_HOSTS, type InboxHost } from '../schema/format.js';

/**
 * The harness a hook invocation runs under. Re-exported from `src/schema/format.ts` —
 * that module owns the closed set of harness literals (A4: it is the one place format
 * constants live), so this module, `src/transcript/host.ts`, and inbox serialization all
 * agree on the same type and the same literal values by construction, not by
 * coincidence.
 */
export type Host = InboxHost;

/** Value used when nothing else identifies the host — the only harness before #18. */
export const DEFAULT_HOST: Host = 'claude-code';

/** True when `value` is one of the closed set of known harness literals. */
function isKnownHost(value: string): value is Host {
  return (INBOX_HOSTS as readonly string[]).includes(value);
}

/**
 * Resolve which harness invoked this hook.
 *
 * `arg` is the explicit host every hook command now carries (`hooks.json` passes it on
 * the command line) — authoritative whenever present, since mehmory writes every hook
 * configuration itself and can always declare rather than infer (A23). Falls back to
 * environment detection only for a hand-written configuration that omits it, and never
 * fails the hook (A2): an empty, missing, or unrecognized argument still resolves to
 * something usable rather than throwing — an unrecognized value is treated the same as
 * an absent one, not as an error, so a typo in a hook configuration degrades to the
 * environment fallback instead of crashing the hook.
 */
export function resolveHost(arg: string | undefined): Host {
  const trimmed = arg?.trim();
  if (trimmed && isKnownHost(trimmed)) return trimmed;
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
