/** Machine-owned format constants for mehmory (A4).
 * Nothing here is ever read from assets/SCHEMA.md; this module is the source of truth.
 */

import { createHash } from 'node:crypto';

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

/** Heading that separates live index lines from demoted (aged) ones (decay, run 2). */
export const ARCHIVE_DIVIDER = '## Archive';

/** Directory name (relative to a scope root) holding pages aged past purge_days. */
export const ARCHIVE_DIR = 'archive';

// ─── Index line format (run-2 amendment 26) ───

/**
 * Normative index line: `- [[slug]] — one-line summary`, one line per page, the
 * wikilink matching the page filename (`pages/<slug>.md`).
 *
 * The summary is optional *when parsing* only. Run-2 amendment 26 mandates it and
 * `formatIndexLine` always emits it, but a hand-written line missing its summary must
 * still associate to its page — the decay pass would otherwise treat that line as
 * prose and orphan it from the page it names.
 */
export const INDEX_LINE_PATTERN = /^\s*-\s+\[\[([^\]]+)\]\](?:\s+—\s*(.*))?$/;

/** One parsed index line. */
export interface IndexLine {
  /** Page slug from the wikilink — the page filename without `.md`. */
  readonly slug: string;
  /** One-line summary; empty when the line carries none. */
  readonly summary: string;
}

/** Parse an index line, or `undefined` when the line is not one (prose, headings). */
export function parseIndexLine(line: string): IndexLine | undefined {
  const m = INDEX_LINE_PATTERN.exec(line.trimEnd());
  if (!m?.[1]) return undefined;
  return { slug: m[1], summary: m[2] ?? '' };
}

/** Serialize an index line in the normative form. */
export function formatIndexLine(slug: string, summary: string): string {
  return `- [[${slug}]] — ${summary}`;
}

// ─── Inbox entry format (A14) ───

/** Length of the hex id embedded in an inbox entry line. */
export const INBOX_ENTRY_ID_LENGTH = 16;

/**
 * Normative single-line inbox entry serialization (A14):
 *
 *   `- <text> <!--mehmory id=<sha256-16> src=<sessionId> ts=<iso8601>-->`
 *
 * The text is human-readable markdown; the trailing HTML comment carries machine
 * identity and is invisible in rendered markdown. Exactly one line per entry, so a
 * single O_APPEND write is atomic (run-1 amendment 2) and snapshot-clear can remove
 * entries by exact line match.
 */
export const INBOX_ENTRY_PATTERN =
  /^- (.*) <!--mehmory id=([0-9a-f]{16}) src=(\S*) ts=(\S+)-->$/;

/** One parsed inbox entry. */
export interface InboxEntry {
  /** 16 hex chars, derived from the distilled entry id (stable across replays). */
  readonly id: string;
  /** Entry text, with embedded newlines unescaped. */
  readonly text: string;
  /** Session id the entry was captured from (record-embedded, not the invoking hook's). */
  readonly src: string;
  /** ISO-8601 capture timestamp. */
  readonly ts: string;
}

/**
 * Derive an inbox entry id from a stable seed (a distilled entry id, or
 * `sessionId + uuid`). Truncated sha256 — collision risk at 16 hex chars is
 * negligible for a per-project inbox that holds tens of entries.
 */
export function inboxEntryId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, INBOX_ENTRY_ID_LENGTH);
}

/**
 * Serialize one inbox entry to its normative single line (no trailing newline).
 *
 * Embedded newlines are JSON-escaped (`\n` → `\\n`) so the one-line invariant holds
 * before the record reaches `appendRecord`, whose escape pass is then a no-op.
 * Carriage returns are dropped; the trailing `-->` sequence in the text would break
 * the comment, so it is neutralized.
 */
export function serializeInboxEntry(entry: InboxEntry): string {
  const text = entry.text
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/-->/g, '--\\>')
    .trim();
  return `- ${text} <!--mehmory id=${entry.id} src=${entry.src} ts=${entry.ts}-->`;
}

/**
 * Parse every inbox entry line out of an inbox.md body. Lines that are not entries
 * (frontmatter, headings, user prose) are ignored — the inbox stays human-editable.
 */
export function parseInboxEntries(content: string): InboxEntry[] {
  const entries: InboxEntry[] = [];
  for (const line of content.split('\n')) {
    const m = INBOX_ENTRY_PATTERN.exec(line.trimEnd());
    if (!m) continue;
    const [, text, id, src, ts] = m;
    if (text === undefined || id === undefined || src === undefined || ts === undefined) {
      continue;
    }
    entries.push({
      id,
      text: text.replace(/--\\>/g, '-->').replace(/\\n/g, '\n'),
      src,
      ts,
    });
  }
  return entries;
}

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
