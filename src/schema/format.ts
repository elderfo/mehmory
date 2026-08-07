/** Machine-owned format constants for mehmory (A4).
 * Nothing here is ever read from assets/SCHEMA.md; this module is the source of truth.
 */

import { createHash } from 'node:crypto';

/** Format version, bumped when the template or structure changes deliberately (U1). */
export const FORMAT_VERSION = 2;

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

/** Read a page's frontmatter as a flat key→value map (values are raw strings). */
export function readFrontmatter(contents: string): Record<string, string> {
  const lines = contents.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DIVIDER) return {};

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === FRONTMATTER_DIVIDER) break;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

/** Milliseconds in a day — shared by every age computation over `updated`. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Age of a page in days from its `updated` frontmatter; null when absent/unparseable. */
export function pageAgeDays(contents: string, now: number): number | null {
  const updated = readFrontmatter(contents)['updated'];
  if (!updated) return null;
  const parsed = Date.parse(updated);
  return Number.isNaN(parsed) ? null : (now - parsed) / MS_PER_DAY;
}

/** Heading that separates live index lines from demoted (aged) ones (decay, run 2). */
export const ARCHIVE_DIVIDER = '## Archive';

/** Directory name (relative to a scope root) holding pages aged past purge_days. */
export const ARCHIVE_DIR = 'archive';

// ─── Retrieval demotion (A22) ───

/**
 * Multiplicative demotion for a page aged past `decay.archive_days` but still live.
 *
 * Multiplicative rather than the subtractive penalty memhub uses, because mehmory's
 * scores are unbounded token-occurrence counts, not a 0–1 blend: subtracting a constant
 * would erase a weak fresh hit and barely dent a strong stale one.
 *
 * The rule these two constants encode: a demoted page is never excluded from retrieval.
 * It stays in the pool, ranks lower, and is flagged `stale` so the caller can say so.
 * Silent exclusion hides a valid memory and gives the user no way to notice.
 */
export const STALE_SCORE_MULTIPLIER = 0.7;

/**
 * Multiplicative demotion for a page already moved into `archive/`.
 *
 * Below `STALE_SCORE_MULTIPLIER` on purpose: archival is an explicit "this aged out"
 * act, a stronger signal than merely drifting past the staleness horizon.
 */
export const ARCHIVED_SCORE_MULTIPLIER = 0.5;

/**
 * True when a page body's `updated` frontmatter is older than `staleAfterDays`.
 *
 * A page with no parseable `updated` is NOT stale: unknown age is not evidence of age,
 * and treating it as stale would demote every hand-written page that skipped frontmatter.
 */
export function isStalePage(contents: string, now: number, staleAfterDays: number): boolean {
  const age = pageAgeDays(contents, now);
  return age !== null && age > staleAfterDays;
}

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
 * The closed set of harnesses that can capture an inbox entry (measured against
 * `.research/codex-spike/VERDICT.md`: mehmory runs under exactly these two). Not a
 * general provenance system — a fixed enum, matching what the rest of the effort
 * threads through hook and CLI arguments.
 */
export const INBOX_HOSTS = ['claude-code', 'codex'] as const;
export type InboxHost = (typeof INBOX_HOSTS)[number];

/** Host attributed to entries written before the `host=` field existed (FORMAT_VERSION 1). */
export const DEFAULT_INBOX_HOST: InboxHost = 'claude-code';

/**
 * Normative single-line inbox entry serialization (A14, FORMAT_VERSION 2):
 *
 *   `- <text> <!--mehmory id=<sha256-16> src=<sessionId> host=<claude-code|codex> ts=<iso8601>-->`
 *
 * The text is human-readable markdown; the trailing HTML comment carries machine
 * identity and is invisible in rendered markdown. Exactly one line per entry, so a
 * single O_APPEND write is atomic (run-1 amendment 2) and snapshot-clear can remove
 * entries by exact line match.
 *
 * `host` sits between `src` and `ts` and is optional in the *pattern* — entries
 * written under FORMAT_VERSION 1 have no `host=` segment at all, and the transactional
 * helper that builds entries pre-dates host-threading too. `parseInboxEntries` fills
 * the gap with `DEFAULT_INBOX_HOST`; `serializeInboxEntry` always emits the field.
 */
export const INBOX_ENTRY_PATTERN =
  /^- (.*) <!--mehmory id=([0-9a-f]{16}) src=(\S*)(?: host=(\S+))? ts=(\S+)-->$/;

/** One parsed inbox entry. */
export interface InboxEntry {
  /** 16 hex chars, derived from the distilled entry id (stable across replays). */
  readonly id: string;
  /** Entry text, with embedded newlines unescaped. */
  readonly text: string;
  /** Session id the entry was captured from (record-embedded, not the invoking hook's). */
  readonly src: string;
  /**
   * Harness that captured the entry. Optional on construction — callers that predate
   * host-threading (e.g. `inbox-tx.ts`) omit it, and `serializeInboxEntry` defaults it
   * to `DEFAULT_INBOX_HOST`. Always present, concretely, on anything `parseInboxEntries`
   * returns.
   */
  readonly host?: InboxHost;
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
 * Carriage returns are dropped; a comment terminator in the text would break the
 * comment, so it is neutralized.
 *
 * Both spellings are neutralized: HTML ends a comment on `--!>` as well as `-->`, and
 * escaping only the latter left the other one live (CodeQL js/bad-tag-filter). The
 * optional `!` is captured and replayed so the escape stays reversible — `parseInboxEntries`
 * undoes exactly this, and losing a character here would corrupt the user's own words.
 */
export function serializeInboxEntry(entry: InboxEntry): string {
  const text = entry.text
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/--(!?)>/g, '--$1\\>')
    .trim();
  const host = entry.host ?? DEFAULT_INBOX_HOST;
  return `- ${text} <!--mehmory id=${entry.id} src=${entry.src} host=${host} ts=${entry.ts}-->`;
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
    const [, text, id, src, rawHost, ts] = m;
    if (text === undefined || id === undefined || src === undefined || ts === undefined) {
      continue;
    }
    // Tolerant of a pre-host (FORMAT_VERSION 1) line, and of a host value outside the
    // current closed set (a future harness's entry read by older code) — both fall
    // back to the default rather than being dropped.
    const host: InboxHost =
      rawHost !== undefined && (INBOX_HOSTS as readonly string[]).includes(rawHost)
        ? (rawHost as InboxHost)
        : DEFAULT_INBOX_HOST;
    entries.push({
      id,
      text: text.replace(/--(!?)\\>/g, '--$1>').replace(/\\n/g, '\n'),
      src,
      host,
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
