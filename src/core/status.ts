/**
 * The one-screen store summary behind `mehmory status` (criterion 9), plus the two
 * read-only git probes `doctor` shares with it.
 *
 * A17 puts this in core rather than in the command file: the numbers are behavior, the
 * layout is not. Nothing here mutates the store, and warnings are read with
 * `peekWarnings()` — `pendingWarnings()` clears as it reads and is SessionStart's only
 * channel, so a `status` that used it would silently steal the user's warning.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mehmoryHome } from './home.js';
import { listDir, pathExists, readFile, stat } from './fs.js';
import { failOpen, peekWarnings } from './errors.js';
import { readInboxEntries } from './inbox.js';
import { parseIndexLine } from '../schema/format.js';

/** The files one scope is made of. `global` has no `projects/<key>` directory. */
export interface ScopeFiles {
  readonly dir: string;
  readonly pagesDir: string;
  readonly indexFile: string;
  readonly inboxFile: string;
  readonly logFile: string;
}

/** Resolve a scope directory to the five files every summary reads. */
export function scopeFiles(dir: string): ScopeFiles {
  return {
    dir,
    pagesDir: join(dir, 'pages'),
    indexFile: join(dir, 'index.md'),
    inboxFile: join(dir, 'inbox.md'),
    logFile: join(dir, 'log.md'),
  };
}

/** Everything `mehmory status` prints, as data. */
export interface StatusReport {
  /** Resolved project key (or `global`). */
  readonly key: string;
  readonly dir: string;
  /** Markdown files under `pages/`. */
  readonly pages: number;
  /** Lines in `index.md` that match the index-line format. */
  readonly indexLines: number;
  readonly inboxEntries: number;
  /** ISO timestamp of the oldest un-integrated inbox entry. */
  readonly oldestInbox?: string;
  /** ISO timestamp of the most recent integrate, parsed out of the `log.md` line. */
  readonly lastIntegrate?: string;
  /** `<short-sha> <date> <subject>` of the store's last commit. */
  readonly lastCommit?: string;
  /** Warnings still pending for the user's next session — read, never consumed. */
  readonly warnings: readonly string[];
}

/** Summarize one scope. Never throws; an unreadable store yields zeroes (A2/A11). */
export function buildStatus(key: string, dir: string): StatusReport {
  const files = scopeFiles(dir);
  const entries = failOpen(() => readInboxEntries(files.inboxFile), [], 'E_APPEND_FAILED');
  const timestamps = entries.map(e => e.ts).sort();
  const oldest = timestamps[0];
  const integrated = lastIntegrate(files.logFile);
  const commit = lastCommit();

  return {
    key,
    dir,
    pages: countPages(files.pagesDir),
    indexLines: countIndexLines(files.indexFile),
    inboxEntries: entries.length,
    ...(oldest !== undefined ? { oldestInbox: oldest } : {}),
    ...(integrated !== undefined ? { lastIntegrate: integrated } : {}),
    ...(commit !== undefined ? { lastCommit: commit } : {}),
    warnings: peekWarnings(),
  };
}

/** Markdown pages in a scope. */
export function countPages(pagesDir: string): number {
  return failOpen(
    () => (pathExists(pagesDir) ? listDir(pagesDir).filter(f => f.endsWith('.md')).length : 0),
    0,
    'E_APPEND_FAILED'
  );
}

/** Lines of `index.md` that are real index lines (A4: the format constant decides). */
export function countIndexLines(indexFile: string): number {
  return failOpen(
    () =>
      pathExists(indexFile)
        ? readFile(indexFile)
            .split('\n')
            .filter(line => parseIndexLine(line) !== undefined).length
        : 0,
    0,
    'E_APPEND_FAILED'
  );
}

/** `log.md` lines, newest last. Empty when the file is absent. */
export function logLines(logFile: string): readonly string[] {
  return failOpen(
    () => (pathExists(logFile) ? readFile(logFile).split('\n').filter(l => l.startsWith('## ')) : []),
    [],
    'E_APPEND_FAILED'
  );
}

/** ISO timestamps of every `integrate` entry in a scope's log, oldest first. */
export function integrateTimestamps(logFile: string): readonly string[] {
  const stamps: string[] = [];
  for (const line of logLines(logFile)) {
    // `appendLogEntry` writes `## <iso> <op> | <summary>`.
    const match = /^## (\S+) (\S+) \|/.exec(line);
    if (match?.[2] === 'integrate' && match[1] !== undefined) stamps.push(match[1]);
  }
  return stamps.sort();
}

/** ISO timestamp of the most recent integrate, or undefined when there has never been one. */
export function lastIntegrate(logFile: string): string | undefined {
  const stamps = integrateTimestamps(logFile);
  return stamps[stamps.length - 1];
}

/** Age of a scope's inbox in ms, from `inbox.md` mtime. Undefined when absent. */
export function inboxAgeMs(inboxFile: string, now: number = Date.now()): number | undefined {
  if (!pathExists(inboxFile)) return undefined;
  const mtime = stat(inboxFile)?.mtime.getTime();
  return mtime === undefined ? undefined : Math.max(0, now - mtime);
}

/** `<short-sha> <date> <subject>` of the store's last commit, or undefined. */
export function lastCommit(): string | undefined {
  try {
    const out = execFileSync(
      'git',
      ['-C', mehmoryHome(), 'log', '-1', '--date=short', '--format=%h %ad %s'],
      { stdio: 'pipe', encoding: 'utf-8' }
    ).trim();
    return out === '' ? undefined : out;
  } catch {
    // No repo, or no commits yet. Both are "nothing to report", not a failure.
    return undefined;
  }
}

/** Paths git reports as dirty in the store, or undefined when the store is not a repo. */
export function dirtyPaths(): readonly string[] | undefined {
  try {
    const out = execFileSync('git', ['-C', mehmoryHome(), 'status', '--porcelain'], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return out.split('\n').filter(line => line.trim() !== '');
  } catch {
    return undefined;
  }
}
