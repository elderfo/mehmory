/** Multi-corpus keyword ranking over a scope wiki: pages, archive and log (A18). */

import { join } from 'node:path';
import { countOccurrences, scoreDoc, tokenize } from './match.js';
import type { Wiki } from './wiki.js';
import { ARCHIVED_SCORE_MULTIPLIER, STALE_SCORE_MULTIPLIER } from '../schema/format.js';

/** Above this many combined pages+archive files in one scope, scan only the newest. */
export const DEFAULT_FILE_CAP = 2000;
const SNIPPET_MAX_LENGTH = 120;

export interface SearchHit {
  /** Path relative to the scope root, e.g. `pages/deploy.md` or `log.md`. */
  readonly path: string;
  readonly scope: string;
  readonly score: number;
  readonly snippet: string;
  /** Demoted, never excluded: aged live pages and everything under archive/ (A22). */
  readonly stale: boolean;
}

export interface SearchOptions {
  readonly fileCap?: number;
}

export interface SearchScan {
  readonly hits: readonly SearchHit[];
  readonly warnings: readonly string[];
}

/** The line with the most matched-token occurrences, trimmed to a bounded width. */
function bestSnippet(tokens: ReadonlySet<string>, body: string): string {
  let best = '';
  let bestScore = -1;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const lower = line.toLowerCase();
    let lineScore = 0;
    for (const token of tokens) lineScore += countOccurrences(lower, token);
    if (lineScore > bestScore) {
      bestScore = lineScore;
      best = line;
    }
  }
  if (best === '') {
    best =
      body
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? '';
  }
  if (best.length <= SNIPPET_MAX_LENGTH) return best;
  let end = SNIPPET_MAX_LENGTH - 1;
  if (
    best.charCodeAt(end - 1) >= 0xd800 &&
    best.charCodeAt(end - 1) <= 0xdbff &&
    best.charCodeAt(end) >= 0xdc00 &&
    best.charCodeAt(end) <= 0xdfff
  )
    end--;
  return best.slice(0, end).trimEnd() + '…';
}

/** Rank one scope; the cap keeps the newest pages/archive and always includes the log. */
export function searchScope(
  query: string,
  scopeLabel: string,
  wiki: Pick<Wiki, 'pages' | 'archive' | 'log'>,
  options: SearchOptions = {}
): SearchScan {
  const tokens = tokenize(query);
  const warnings: string[] = [];
  if (tokens.size === 0) return { hits: [], warnings };

  const fileCap = options.fileCap ?? DEFAULT_FILE_CAP;
  let docs = [
    ...wiki.pages.map((page) => ({
      page,
      path: join('pages', `${page.slug}.md`),
      archived: false,
    })),
    ...wiki.archive.map((page) => ({
      page,
      path: join('archive', `${page.slug}.md`),
      archived: true,
    })),
  ];
  if (docs.length > fileCap) {
    const total = docs.length;
    docs = [...docs].sort((a, b) => b.page.mtimeMs - a.page.mtimeMs).slice(0, fileCap);
    warnings.push(
      `${scopeLabel}: scanned the newest ${String(fileCap)} of ${String(total)} files (file cap)`
    );
  }

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const page = doc.page;
    const score = scoreDoc(tokens, page.body.toLowerCase(), page.title);
    const demotion = doc.archived
      ? ARCHIVED_SCORE_MULTIPLIER
      : page.stale
        ? STALE_SCORE_MULTIPLIER
        : 1;
    if (score > 0) {
      hits.push({
        path: doc.path,
        scope: scopeLabel,
        score: Math.round(score * demotion * 100) / 100,
        snippet: bestSnippet(tokens, page.body),
        stale: doc.archived || page.stale,
      });
    }
  }

  // The log records what happened, not a claim that can go stale.
  const logBody = wiki.log;
  const logScore = scoreDoc(tokens, logBody.toLowerCase(), 'log.md');
  if (logScore > 0) {
    hits.push({
      path: 'log.md',
      scope: scopeLabel,
      score: logScore,
      snippet: bestSnippet(tokens, logBody),
      stale: false,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { hits, warnings };
}
