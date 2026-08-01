/**
 * Grep-style full-text page matching for UserPromptSubmit (run 2; run 3 replaces the
 * scan with an FTS index behind the same signature).
 *
 * No index, no state: read the pages, count token hits, return the best few. A wiki
 * that fits in a token budget is a few dozen small files, so a full scan is cheaper
 * than maintaining an index would be.
 *
 * ponytail: O(pages × tokens) scan per prompt; ceiling is a store with thousands of
 * pages. Upgrade path is run 3's SQLite FTS5 index behind `matchPages`.
 */

import { basename, join } from 'node:path';
import { listDir, pathExists, readFile, stat } from './fs.js';
import { isStalePage, STALE_SCORE_MULTIPLIER } from '../schema/format.js';

/** Tokens shorter than this are dropped — they match everything. */
const MIN_TOKEN_LENGTH = 3;

/** Words too common to discriminate between pages. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old',
  'see', 'two', 'way', 'who', 'boy', 'did', 'use', 'this', 'that', 'with', 'from',
  'have', 'they', 'what', 'when', 'will', 'your', 'about', 'would', 'there', 'their',
  'should', 'could', 'please', 'need', 'want', 'make', 'does', 'into', 'just', 'like',
]);

/** Split text into lowercase content tokens (shared by matching and the topic cache). */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

/**
 * Jaccard similarity |A ∩ B| / |A ∪ B|. Two empty sets are identical (1); one empty
 * set against a non-empty one is 0.
 */
export function jaccard(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function countOccurrences(haystack: string, token: string): number {
  let count = 0;
  let index = haystack.indexOf(token);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(token, index + token.length);
  }
  return count;
}

/** One matched page: where it lives, and whether it has aged past the staleness horizon. */
export interface MatchedPage {
  /** Page path relative to the scope root, e.g. `pages/deploy.md`. */
  readonly path: string;
  /** True when the page is older than `staleAfterDays` — demoted, never excluded. */
  readonly stale: boolean;
}

/** Threading for the staleness rule; both default to "no page is stale" (A22). */
export interface MatchOptions {
  /** `config.decay.archive_days`. Omitted → staleness is not evaluated at all. */
  readonly staleAfterDays?: number;
  /** Clock override for tests. */
  readonly now?: number;
}

/**
 * Rank the pages in `pagesDir` against a prompt and return the best matches.
 *
 * Scores a page by how often the prompt's tokens appear in its body, with title and
 * filename hits weighted ×3. Pages with no hit are excluded, so "no match" is an
 * empty array (the hook's silent path).
 *
 * A page past `staleAfterDays` is **demoted, not dropped** (A22): its score is scaled by
 * `STALE_SCORE_MULTIPLIER` and it comes back flagged `stale`, so a stale page still wins
 * over nothing and the caller can say which pointers are old. Without `staleAfterDays`
 * no page is stale and ranking is byte-identical to the pre-A22 behavior.
 *
 * @param prompt - Raw user prompt
 * @param pagesDir - Directory holding `*.md` pages (e.g. `<scope>/pages`)
 * @param max - Maximum pointers to return (default 3)
 * @param options - Staleness horizon and clock
 * @returns Matched pages, best first
 */
export function matchPages(
  prompt: string,
  pagesDir: string,
  max = 3,
  options: MatchOptions = {}
): MatchedPage[] {
  const tokens = tokenize(prompt);
  if (tokens.size === 0 || !pathExists(pagesDir)) return [];

  const now = options.now ?? Date.now();
  const prefix = basename(pagesDir);
  const scored: { path: string; score: number; stale: boolean }[] = [];

  for (const name of listDir(pagesDir)) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(pagesDir, name);

    let contents: string;
    try {
      if (!stat(filePath)?.isFile()) continue;
      contents = readFile(filePath);
    } catch {
      continue; // unreadable page: skip, never fail the prompt
    }

    // Staleness reads the raw text: `Date.parse` is not reliable on a lowercased
    // ISO timestamp, so the case-folded copy below is only ever used for scoring.
    const stale =
      options.staleAfterDays !== undefined &&
      isStalePage(contents, now, options.staleAfterDays);

    const body = contents.toLowerCase();
    const titleLine = /^#\s+(.*)$/m.exec(body);
    const title = `${name.toLowerCase()} ${titleLine?.[1] ?? ''}`;

    let score = 0;
    for (const token of tokens) {
      score += countOccurrences(body, token) + 3 * countOccurrences(title, token);
    }
    if (score > 0) {
      scored.push({
        path: join(prefix, name),
        score: stale ? score * STALE_SCORE_MULTIPLIER : score,
        stale,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, max).map(s => ({ path: s.path, stale: s.stale }));
}
