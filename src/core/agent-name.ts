/**
 * What makes an agent name usable as a directory segment (R1, R5).
 *
 * Split out from `agent.ts` so the rule can be shared without the resolution machinery:
 * `schema/format.ts` validates a stamp it parsed and needs only this predicate, while
 * `agent.ts` also warns through `errors.ts`, which reaches the filesystem. Keeping the
 * two apart stops a module of pure format constants from importing the error subsystem.
 *
 * This module deliberately imports nothing.
 */

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
export const RESERVED_AGENT_NAMES: readonly string[] = ['global', 'projects', 'agents', 'all'];

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
