/**
 * Mechanical recency decay: index re-sort, demotion, archival (spec's 60/90-day rules).
 *
 * Pure file operations over one scope directory (`<home>/global` or
 * `<home>/projects/<key>`), which must contain `index.md` and `pages/`. The caller
 * holds the project lock — SessionStart runs this on the maintenance lane (A16) and
 * skips it entirely when the lock is contended, so acquiring it here would hide that.
 *
 * Only the `default` decay class ages. `evergreen` and `ephemeral` pages are never
 * touched: evergreen is exempt by definition, and ephemeral is refreshed-or-deleted
 * editorially by `integrate` (run-1 amendment 10, closed by spec gap 19).
 */

import { atomicWrite } from './fs.js';
import type { MehmoryConfig } from './config.js';
import { archivePage, openScope, type WikiIndex } from './wiki.js';
import { failOpen } from './errors.js';
import { ARCHIVE_DIVIDER, isStalePage } from '../schema/format.js';

export { readFrontmatter } from '../schema/format.js';

/** What a decay pass changed. Page names include the `.md` extension. */
export interface DecayResult {
  /** Pages whose index line moved below the Archive divider (older than archive_days). */
  demoted: string[];
  /** Pages moved into `archive/` and dropped from the index (older than purge_days). */
  archived: string[];
  /** True when index.md was rewritten. */
  rewroteIndex: boolean;
}

/**
 * Run a decay pass over one scope.
 *
 * - pages older than `archive_days` (default 60): index line demoted below `## Archive`
 * - pages older than `purge_days` (default 90): file moved to `archive/`, index line dropped
 * - remaining index page-lines: re-sorted newest-`updated` first
 *
 * Disabled config (`decay.enabled: false`) makes this a no-op. Never throws (A2/A11).
 *
 * @param scopeDir - Scope root containing `index.md` and `pages/`
 * @param options - Overrides for the clock and the day thresholds (tests, run-3 CLI)
 */
export function decayPass(
  scopeDir: string,
  config: MehmoryConfig,
  options: { now?: number; archiveDays?: number; purgeDays?: number } = {}
): DecayResult {
  const empty: DecayResult = { demoted: [], archived: [], rewroteIndex: false };

  return failOpen(
    () => {
      if (!config.decay.enabled) return empty;

      const now = options.now ?? Date.now();
      const archiveDays = options.archiveDays ?? config.decay.archive_days;
      const purgeDays = options.purgeDays ?? config.decay.purge_days;

      const wiki = openScope(scopeDir, { now, staleAfterDays: archiveDays });
      if (!wiki.pagesReadable) return empty;

      const demoted: string[] = [];
      const archived: string[] = [];
      /** page file → updated epoch ms, for the recency re-sort. */
      const liveOrder = new Map<string, number>();

      for (const page of wiki.pages) {
        const name = `${page.slug}.md`;
        if (isStalePage(page.frontmatter, now, purgeDays)) {
          if (!archivePage(wiki.scope, page)) return empty;
          archived.push(name);
        } else if (page.stale) {
          demoted.push(name);
        } else {
          liveOrder.set(name, page.updatedAt ?? 0);
        }
      }

      if (!wiki.index.readable) {
        return { demoted, archived, rewroteIndex: false };
      }

      const original = wiki.index.body;
      const rewritten = rewriteIndex(wiki.index, liveOrder, demoted, archived);
      if (rewritten === original) return { demoted, archived, rewroteIndex: false };

      atomicWrite(wiki.scope.indexFile, rewritten);
      return { demoted, archived, rewroteIndex: true };
    },
    empty,
    'E_ATOMIC_WRITE'
  );
}

/**
 * Rebuild index.md: live page lines newest-first, then `## Archive` with the demoted
 * lines, with every non-page line (frontmatter, headings, prose) kept in place.
 *
 * The wiki reader supplies parsed line positions; everything else remains preamble.
 */
function rewriteIndex(
  index: WikiIndex,
  liveOrder: ReadonlyMap<string, number>,
  demoted: readonly string[],
  archived: readonly string[]
): string {
  const lines = index.body.split('\n');
  const preamble: string[] = [];
  const live: { line: string; updated: number }[] = [];
  const belowDivider: string[] = [];

  const known = new Set([...liveOrder.keys(), ...demoted, ...archived]);
  const pageLines = new Map(
    index.lines
      .filter((entry) => known.has(`${entry.slug}.md`))
      .map((entry) => [entry.line, `${entry.slug}.md`])
  );

  for (const [offset, line] of lines.entries()) {
    if (line.trim() === ARCHIVE_DIVIDER) continue; // re-emitted below if still needed

    const page = pageLines.get(offset);
    if (page === undefined) {
      preamble.push(line);
      continue;
    }
    if (archived.includes(page)) continue; // page left the scope
    if (demoted.includes(page)) {
      belowDivider.push(line);
      continue;
    }
    live.push({ line, updated: liveOrder.get(page) ?? 0 });
  }

  // Trim trailing blank lines from the preamble so sections join cleanly.
  while (preamble.length > 0 && preamble[preamble.length - 1]?.trim() === '') preamble.pop();

  const out = [...preamble];
  if (live.length > 0) {
    live.sort((a, b) => b.updated - a.updated);
    out.push('', ...live.map((l) => l.line));
  }
  if (belowDivider.length > 0) {
    out.push('', ARCHIVE_DIVIDER, '', ...belowDivider);
  }
  out.push('');

  return out.join('\n');
}
