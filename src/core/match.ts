/** Stateless keyword ranking shared by prompt pointers and multi-corpus search. */

import { STALE_SCORE_MULTIPLIER } from '../schema/format.js';
import type { WikiPage } from './wiki.js';

/** Tokens shorter than this are dropped — they match everything. */
const MIN_TOKEN_LENGTH = 3;

/** Words too common to discriminate between pages. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'her',
  'was',
  'one',
  'our',
  'out',
  'day',
  'get',
  'has',
  'him',
  'his',
  'how',
  'its',
  'new',
  'now',
  'old',
  'see',
  'two',
  'way',
  'who',
  'boy',
  'did',
  'use',
  'this',
  'that',
  'with',
  'from',
  'have',
  'they',
  'what',
  'when',
  'will',
  'your',
  'about',
  'would',
  'there',
  'their',
  'should',
  'could',
  'please',
  'need',
  'want',
  'make',
  'does',
  'into',
  'just',
  'like',
]);

/** Split text into lowercase content tokens (shared by matching and the topic cache). */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

/** Jaccard similarity; two empty sets are identical, one empty against non-empty is 0. */
export function jaccard(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function countOccurrences(haystack: string, token: string): number {
  let count = 0;
  let index = haystack.indexOf(token);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(token, index + token.length);
  }
  return count;
}

/** Shared title/filename weighting for the prompt matcher and multi-corpus search. */
export function scoreDoc(
  tokens: ReadonlySet<string>,
  lowerBody: string,
  lowerTitle: string
): number {
  let score = 0;
  for (const token of tokens) {
    score += countOccurrences(lowerBody, token) + 3 * countOccurrences(lowerTitle, token);
  }
  return score;
}

export interface MatchedPage {
  /** Absolute path, readable directly from the user's repository cwd. */
  readonly path: string;
  readonly stale: boolean;
}

/** Rank wiki pages by token occurrences, with filename/heading hits weighted ×3 (A22). */
export function matchPages(
  prompt: string,
  pages: readonly Pick<WikiPage, 'path' | 'body' | 'title' | 'stale'>[],
  max = 3
): MatchedPage[] {
  const tokens = tokenize(prompt);
  if (tokens.size === 0) return [];
  const scored: { path: string; score: number; stale: boolean }[] = [];
  for (const page of pages) {
    const score = scoreDoc(tokens, page.body.toLowerCase(), page.title);
    if (score > 0) {
      scored.push({
        path: page.path,
        score: page.stale ? score * STALE_SCORE_MULTIPLIER : score,
        stale: page.stale,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, max).map((s) => ({ path: s.path, stale: s.stale }));
}
