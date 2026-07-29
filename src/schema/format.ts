/** Machine-owned format constants for mehmory (A4).
 * Nothing here is ever read from assets/SCHEMA.md; this module is the source of truth.
 */

/** Format version, bumped when the template or structure changes deliberately (U1). */
export const FORMAT_VERSION = 1;

/** Page type enumeration for frontmatter. */
export const PAGE_TYPES = ['decision', 'procedure', 'entity', 'preference', 'gotcha'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** Decay class enumeration for page lifecycle.
 * Fixed by the spec's 2026-07-28 gate outcome, which supersedes the Decisions log:
 *   evergreen — rarely stale, kept front-and-center; exempt from mechanical decay
 *   ephemeral — refreshed-or-deleted on each integrate (run 2 owns the threshold)
 *   default   — the only class the mechanical 60/90-day archive/purge rules apply to
 */
export const DECAY_CLASSES = ['evergreen', 'ephemeral', 'default'] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

/** Frontmatter keys that may appear in pages. */
export const FRONTMATTER_KEYS = {
  updated: 'updated',
  type: 'type',
  refs: 'refs',
  decay: 'decay',
  schema_version: 'schema_version'
} as const;

/** Divider text used to separate frontmatter from content. */
export const FRONTMATTER_DIVIDER = '---';

/** User error template (U1), versioned by FORMAT_VERSION.
 * Exact template: MEHMORY E_<CODE>: <what>. <consequence>. [Fix: <command>. ]Details: <errors.log path>
 * The [Fix: ...] clause is emitted only for actionable errors.
 */
export const USER_ERROR_TEMPLATE = (
  code: string,
  what: string,
  consequence: string,
  isActionable: boolean,
  fix?: string,
  detailsPath?: string
): string => {
  let result = `MEHMORY ${code}: ${what}. ${consequence}.`;
  if (isActionable && fix) {
    result += ` Fix: ${fix}.`;
  }
  const logPath = detailsPath ?? '~/.mehmory/.state/errors.log';
  result += ` Details: ${logPath}`;
  return result;
};
