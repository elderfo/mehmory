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

/**
 * Rank the pages in `pagesDir` against a prompt and return the best matches.
 *
 * Scores a page by how often the prompt's tokens appear in its body, with title and
 * filename hits weighted ×3. Pages with no hit are excluded, so "no match" is an
 * empty array (the hook's silent path).
 *
 * @param prompt - Raw user prompt
 * @param pagesDir - Directory holding `*.md` pages (e.g. `<scope>/pages`)
 * @param max - Maximum pointers to return (default 3)
 * @returns Page paths relative to the scope root, e.g. `pages/deploy.md`, best first
 */
export function matchPages(prompt: string, pagesDir: string, max = 3): string[] {
  const tokens = tokenize(prompt);
  if (tokens.size === 0 || !pathExists(pagesDir)) return [];

  const prefix = basename(pagesDir);
  const scored: { path: string; score: number }[] = [];

  for (const name of listDir(pagesDir)) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(pagesDir, name);

    let body: string;
    try {
      if (!stat(filePath)?.isFile()) continue;
      body = readFile(filePath).toLowerCase();
    } catch {
      continue; // unreadable page: skip, never fail the prompt
    }

    const titleLine = /^#\s+(.*)$/m.exec(body);
    const title = `${name.toLowerCase()} ${titleLine?.[1] ?? ''}`;

    let score = 0;
    for (const token of tokens) {
      score += countOccurrences(body, token) + 3 * countOccurrences(title, token);
    }
    if (score > 0) scored.push({ path: join(prefix, name), score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, max).map(s => s.path);
}
