/**
 * Which agent is running (R1, R5). Resolved here in core and threaded to callers —
 * config arrives as a parameter, never read ambiently (A21).
 *
 * Precedence is the mirror image of `resolveHost`: the environment wins, because
 * `MEHMORY_AGENT` is what a launcher sets per instance, and `config.identity.agent`
 * is the machine-wide default underneath it.
 */

import { logError } from './errors.js';
import { isSafeAgentName, RESERVED_AGENT_NAMES } from './agent-name.js';
import type { MehmoryConfig } from './config.js';

// Re-exported so `agent.js` stays the one import site for callers that want both the
// predicate and the resolution; `schema/format.ts` takes it from `agent-name.js`
// directly, which is the edge this split exists to cut.
export { isSafeAgentName } from './agent-name.js';

/**
 * Resolve the running agent's name, or `undefined` when it is unnamed.
 *
 * An unsafe name is refused, never rewritten (no hash fallback, unlike
 * `safeRemoteKey`: a hashed self is unreadable, and readability is the point). A
 * refusal is warned about and returns unnamed rather than throwing (A2), and does not
 * fall through to the lower-precedence source — a declared-but-invalid name is a
 * mistake to fix, not a reason to silently adopt a different identity.
 *
 * An absent value is the empty string, `undefined`, or `null` — the three spellings of
 * "no agent" (JSON has no `undefined`, so a config file writes `null`). Anything else is
 * a declaration and is validated exactly as written. The distinction is absence, not
 * falsiness: `false` and `0` are present values that failed, and reading them as unset
 * would swallow the one warning that tells the user their config line does nothing.
 *
 * `configValue` is `unknown` because it is: `loadConfig` deep-merges unvalidated JSON and
 * casts, so `identity.agent` carries whatever the file held. A wrong type is refused on
 * the same warn-and-degrade path as a badly spelled name rather than reaching the string
 * checks below and throwing — the same guard `parseInboxEntry` already applies to a
 * stamped value it did not write.
 */
export function resolveAgentName(
  envValue: string | undefined,
  configValue: unknown
): string | undefined {
  if (envValue) return validated(envValue, 'MEHMORY_AGENT');
  if (isAbsent(configValue)) return undefined;
  return validated(configValue, 'config.identity.agent');
}

/** True for the three ways a config says "no agent"; everything else is a declaration. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The running agent's name, or `undefined` when it is unnamed.
 *
 * The one place that knows `MEHMORY_AGENT` is the variable to read — callers hold a
 * threaded `config` and should not each restate where the two candidate values come
 * from. The env var is read at point of use the way `mehmoryHome()` reads its own; A21
 * governs *config*, which still arrives as a parameter.
 */
export function currentAgentName(config: MehmoryConfig): string | undefined {
  return resolveAgentName(process.env['MEHMORY_AGENT'], config.identity.agent);
}

/** The name if safe; otherwise unnamed, with a warning naming the value and its source. */
function validated(value: unknown, source: string): string | undefined {
  if (typeof value === 'string' && isSafeAgentName(value)) return value;
  const shown = describe(value);
  logError({
    code: 'E_AGENT_NAME_INVALID',
    kind: 'actionable',
    what: `${source} is ${shown}, which is not a safe agent name`,
    consequence: 'This agent is treated as unnamed and gets no agent scope',
    // Names every rule the value will actually be judged against: a fix a user can
    // follow and still be refused is worse than none.
    fix: `set ${source} to 1-64 chars of [a-z0-9._-], not starting with a dot, and not one of: ${RESERVED_AGENT_NAMES.join(', ')}`,
  });
  return undefined;
}

/**
 * A rejected value as the user should see it. `"[object Object]"` names nothing they can
 * find in their config, so a non-string is named by what it is — with the article that
 * makes the sentence read, since this text ends up in `errors.log` verbatim.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
