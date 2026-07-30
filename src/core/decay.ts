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

import { join } from 'node:path';
import { atomicWrite, listDir, mkdir, pathExists, readFile, rename, stat } from './fs.js';
import { loadConfig } from './config.js';
import { failOpen } from './errors.js';
import { ARCHIVE_DIR, ARCHIVE_DIVIDER, FRONTMATTER_DIVIDER } from '../schema/format.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What a decay pass changed. Page names include the `.md` extension. */
export interface DecayResult {
  /** Pages whose index line moved below the Archive divider (older than archive_days). */
  demoted: string[];
  /** Pages moved into `archive/` and dropped from the index (older than purge_days). */
  archived: string[];
  /** True when index.md was rewritten. */
  rewroteIndex: boolean;
}

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

/** Age of a page in days from its `updated` frontmatter; null when absent/unparseable. */
function ageDays(contents: string, now: number): number | null {
  const updated = readFrontmatter(contents)['updated'];
  if (!updated) return null;
  const parsed = Date.parse(updated);
  return Number.isNaN(parsed) ? null : (now - parsed) / MS_PER_DAY;
}

/** True when an index line refers to this page (by `[[wikilink]]`, filename, or path). */
function lineRefersTo(line: string, pageFile: string): boolean {
  const slug = pageFile.replace(/\.md$/, '');
  return (
    line.includes(`[[${slug}]]`) ||
    line.includes(pageFile) ||
    new RegExp(`(^|[^\\w-])${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(line)
  );
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
  options: { now?: number; archiveDays?: number; purgeDays?: number } = {}
): DecayResult {
  const empty: DecayResult = { demoted: [], archived: [], rewroteIndex: false };

  return failOpen(
    () => {
      const config = loadConfig();
      if (!config.decay.enabled) return empty;

      const now = options.now ?? Date.now();
      const archiveDays = options.archiveDays ?? config.decay.archive_days;
      const purgeDays = options.purgeDays ?? config.decay.purge_days;

      const pagesDir = join(scopeDir, 'pages');
      const indexPath = join(scopeDir, 'index.md');
      if (!pathExists(pagesDir)) return empty;

      const demoted: string[] = [];
      const archived: string[] = [];
      /** page file → updated epoch ms, for the recency re-sort. */
      const liveOrder = new Map<string, number>();

      for (const name of listDir(pagesDir)) {
        if (!name.endsWith('.md')) continue;
        const pagePath = join(pagesDir, name);
        if (!stat(pagePath)?.isFile()) continue;

        const contents = readFile(pagePath);
        const fields = readFrontmatter(contents);
        const decayClass = fields['decay'] ?? 'default';
        const age = ageDays(contents, now);
        const updatedAt = Date.parse(fields['updated'] ?? '');

        if (decayClass !== 'default' || age === null) {
          // Untouched by mechanical decay, but still ordered in the index.
          liveOrder.set(name, Number.isNaN(updatedAt) ? 0 : updatedAt);
          continue;
        }

        if (age > purgeDays) {
          const archiveDir = join(scopeDir, ARCHIVE_DIR);
          mkdir(archiveDir);
          rename(pagePath, join(archiveDir, name));
          archived.push(name);
        } else if (age > archiveDays) {
          demoted.push(name);
        } else {
          liveOrder.set(name, Number.isNaN(updatedAt) ? 0 : updatedAt);
        }
      }

      if (!pathExists(indexPath)) {
        return { demoted, archived, rewroteIndex: false };
      }

      const original = readFile(indexPath);
      const rewritten = rewriteIndex(original, liveOrder, demoted, archived);
      if (rewritten === original) return { demoted, archived, rewroteIndex: false };

      atomicWrite(indexPath, rewritten);
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
 * ponytail: the index line format is editorial (the model writes it), so association
 * is by page-name occurrence rather than a parsed grammar. Ceiling: a prose line that
 * happens to name a page is treated as that page's line. Upgrade path is a format
 * constant in `format.ts` once the skills settle on one.
 */
function rewriteIndex(
  contents: string,
  liveOrder: ReadonlyMap<string, number>,
  demoted: readonly string[],
  archived: readonly string[]
): string {
  const lines = contents.split('\n');
  const preamble: string[] = [];
  const live: { line: string; updated: number }[] = [];
  const belowDivider: string[] = [];

  const findPage = (line: string): string | undefined => {
    for (const name of [...liveOrder.keys(), ...demoted, ...archived]) {
      if (lineRefersTo(line, name)) return name;
    }
    return undefined;
  };

  for (const line of lines) {
    if (line.trim() === ARCHIVE_DIVIDER) continue; // re-emitted below if still needed

    const page = findPage(line);
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
    out.push('', ...live.map(l => l.line));
  }
  if (belowDivider.length > 0) {
    out.push('', ARCHIVE_DIVIDER, '', ...belowDivider);
  }
  out.push('');

  return out.join('\n');
}
