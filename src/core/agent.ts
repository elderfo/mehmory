/**
 * Which agent is running (R1, R5). Resolved here in core and threaded to callers —
 * config arrives as a parameter, never read ambiently (A21).
 *
 * Precedence is the mirror image of `resolveHost`: the environment wins, because
 * `MEHMORY_AGENT` is what a launcher sets per instance, and `config.identity.agent`
 * is the machine-wide default underneath it.
 */

import { logError } from './errors.js';

/**
 * An agent name becomes a directory name under <home>/agents/, so it must not be able
 * to escape that root — the same concern as `SAFE_KEY` in `src/core/identity.ts`, but
 * over a single segment rather than a host/owner/repo path.
 *
 * Lowercase only: on a case-insensitive filesystem `Scout` and `scout` would silently
 * share one scope. Refusing a mixed-case name rather than folding it keeps the
 * never-rewrite rule intact.
 */
const SAFE_AGENT_NAME = /^[a-z0-9._-]+$/;

/** Tokens the scope grammar already owns; an agent may not shadow one. */
const RESERVED_AGENT_NAMES: readonly string[] = ['global', 'projects', 'agents', 'all'];

/** Directory-name ceiling, well under every filesystem's limit. */
const MAX_AGENT_NAME_LENGTH = 64;

/** True when `name` is safe to use as a single directory segment under `agents/`. */
export function isSafeAgentName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_AGENT_NAME_LENGTH) return false;
  if (!SAFE_AGENT_NAME.test(name)) return false;
  // A leading `.` passes the character class above: `.` and `..` collapse the path,
  // and any other dotted name is a hidden directory under `agents/` (`.git` being the
  // one that would do real damage). Refused as a class rather than case by case.
  if (name.startsWith('.')) return false;
  return !RESERVED_AGENT_NAMES.includes(name);
}

/**
 * Resolve the running agent's name, or `undefined` when it is unnamed.
 *
 * An unsafe name is refused, never rewritten (no hash fallback, unlike
 * `safeRemoteKey`: a hashed self is unreadable, and readability is the point). A
 * refusal is warned about and returns unnamed rather than throwing (A2), and does not
 * fall through to the lower-precedence source — a declared-but-invalid name is a
 * mistake to fix, not a reason to silently adopt a different identity.
 *
 * An absent value is the empty string or `undefined`; only a non-empty value is a
 * declaration, and it is validated exactly as written.
 */
export function resolveAgentName(
  envValue: string | undefined,
  configValue: string | undefined
): string | undefined {
  if (envValue) return validated(envValue, 'MEHMORY_AGENT');
  if (configValue) return validated(configValue, 'config.identity.agent');
  return undefined;
}

/** The name if safe; otherwise unnamed, with a warning naming the value and its source. */
function validated(value: string, source: string): string | undefined {
  if (isSafeAgentName(value)) return value;
  logError({
    code: 'E_AGENT_NAME_INVALID',
    kind: 'actionable',
    what: `${source} is "${value}", which is not a safe agent name`,
    consequence: 'This agent is treated as unnamed and gets no agent scope',
    fix: `set ${source} to a lowercase name matching [a-z0-9._-]{1,64}`,
  });
  return undefined;
}
