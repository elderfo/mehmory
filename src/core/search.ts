/**
 * Multi-corpus search scan (criterion 7, A18): pages, archive, and log.md.
 *
 * Extends `match.ts`'s scoring — token frequency, title/filename weighted ×3 — to
 * every corpus a scope holds. `matchPages()` is untouched: the hook keeps its
 * narrower, pages-only scan (criterion 19). This is the only search implementation in
 * the product: no index, no sqlite, no capability probe (A18).
 *
 * ponytail: O(files × tokens) scan per query, same shape as `match.ts`. Ceiling is the
 * file cap below; upgrade path is FTS5 behind this same interface if the corpus ever
 * measurably outgrows a scan (see the plan's judgment entry).
 */

import { join } from 'node:path';
import { listDir, pathExists, readFile, stat } from './fs.js';
import { tokenize } from './match.js';

/** Above this many combined pages+archive files in one scope, scan only the newest. */
export const DEFAULT_FILE_CAP = 2000;

/** Longest a snippet line is allowed to be before it is truncated. */
const SNIPPET_MAX_LENGTH = 120;

/** One ranked hit. */
export interface SearchHit {
  /** Path relative to the scope root, e.g. `pages/deploy.md` or `log.md`. */
  readonly path: string;
  /** Scope label the caller supplies, carried through so `--all` results stay attributed. */
  readonly scope: string;
  readonly score: number;
  readonly snippet: string;
}

/** The files one scope's scan reads. */
export interface SearchFiles {
  readonly pagesDir: string;
  readonly archiveDir: string;
  readonly logFile: string;
}

export interface SearchOptions {
  /** Combined pages+archive file cap. Default `DEFAULT_FILE_CAP`. */
  readonly fileCap?: number;
}

export interface SearchScan {
  readonly hits: readonly SearchHit[];
  /** Non-fatal notices, e.g. the file cap having cut the scan short. Never silent. */
  readonly warnings: readonly string[];
}

interface Doc {
  readonly path: string;
  /** Lowercased filename plus first heading (pages/archive) or a fixed label (log). */
  readonly title: string;
  readonly body: string;
  readonly mtimeMs: number;
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

/** Same weighting as `matchPages`: title/filename hits count triple. */
function scoreDoc(tokens: ReadonlySet<string>, lowerBody: string, lowerTitle: string): number {
  let score = 0;
  for (const token of tokens) {
    score += countOccurrences(lowerBody, token) + 3 * countOccurrences(lowerTitle, token);
  }
  return score;
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
    best = body.split('\n').find(l => l.trim() !== '')?.trim() ?? '';
  }
  return best.length > SNIPPET_MAX_LENGTH
    ? best.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd() + '…'
    : best;
}

function markdownDocs(dir: string, pathPrefix: string): Doc[] {
  const docs: Doc[] = [];
  if (!pathExists(dir)) return docs;
  for (const name of listDir(dir)) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(dir, name);
    let body: string;
    let mtimeMs: number;
    try {
      const stats = stat(filePath);
      if (!stats?.isFile()) continue;
      mtimeMs = stats.mtime.getTime();
      body = readFile(filePath);
    } catch {
      continue; // unreadable file: skip, never fail the scan
    }
    const titleLine = /^#\s+(.*)$/m.exec(body);
    docs.push({
      path: join(pathPrefix, name),
      title: `${name.toLowerCase()} ${(titleLine?.[1] ?? '').toLowerCase()}`,
      body,
      mtimeMs,
    });
  }
  return docs;
}

/**
 * Scan one scope's pages, archive and log for `query`, returning ranked hits with
 * snippets plus any bounding warning.
 *
 * `pagesDir`/`archiveDir` are scanned as directories of `.md` files; `logFile` is
 * scanned as a single line-oriented file — the corpus `matchPages()` structurally
 * cannot reach, since it takes one directory. Over `fileCap` combined pages+archive
 * files, only the newest are scanned and a warning names the cut; the file is never
 * silently dropped.
 */
export function searchScope(
  query: string,
  scopeLabel: string,
  files: SearchFiles,
  options: SearchOptions = {}
): SearchScan {
  const tokens = tokenize(query);
  const warnings: string[] = [];
  if (tokens.size === 0) return { hits: [], warnings };

  const fileCap = options.fileCap ?? DEFAULT_FILE_CAP;
  let docs = [
    ...markdownDocs(files.pagesDir, 'pages'),
    ...markdownDocs(files.archiveDir, 'archive'),
  ];

  if (docs.length > fileCap) {
    const total = docs.length;
    docs = [...docs].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, fileCap);
    warnings.push(
      `${scopeLabel}: scanned the newest ${String(fileCap)} of ${String(total)} files (file cap)`
    );
  }

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const score = scoreDoc(tokens, doc.body.toLowerCase(), doc.title);
    if (score > 0) {
      hits.push({ path: doc.path, scope: scopeLabel, score, snippet: bestSnippet(tokens, doc.body) });
    }
  }

  if (pathExists(files.logFile)) {
    let logBody: string | undefined;
    try {
      if (stat(files.logFile)?.isFile()) logBody = readFile(files.logFile);
    } catch {
      logBody = undefined; // unreadable log: skip, never fail the scan
    }
    if (logBody !== undefined) {
      const score = scoreDoc(tokens, logBody.toLowerCase(), 'log.md');
      if (score > 0) {
        hits.push({ path: 'log.md', scope: scopeLabel, score, snippet: bestSnippet(tokens, logBody) });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { hits, warnings };
}
