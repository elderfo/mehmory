/** Scope layout and fail-open wiki reads, shared by retrieval, injection and maintenance. */

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mehmoryHome } from './home.js';
import { listDir, lstat, mkdir, pathExists, readFile, realpath, rename, stat } from './fs.js';
import { failOpen } from './errors.js';
import { isSafeAgentName } from './agent-name.js';
import { listProjects } from './scopes.js';
import {
  ARCHIVE_DIR,
  ARCHIVE_DIVIDER,
  isStalePage,
  MS_PER_DAY,
  parseIndexLine,
  readFrontmatter,
  type IndexLine,
} from '../schema/format.js';

/** The layout of a wiki scope, independent of how the caller selected it. */
export interface WikiScope {
  readonly dir: string;
  readonly pagesDir: string;
  readonly archiveDir: string;
  readonly indexFile: string;
  readonly identityFile: string;
  readonly projectFile: string;
  readonly inboxFile: string;
  readonly logFile: string;
}

export function wikiScope(dir: string): WikiScope {
  return {
    dir,
    pagesDir: join(dir, 'pages'),
    archiveDir: join(dir, ARCHIVE_DIR),
    indexFile: join(dir, 'index.md'),
    identityFile: join(dir, 'identity.md'),
    projectFile: join(dir, 'project.md'),
    inboxFile: join(dir, 'inbox.md'),
    logFile: join(dir, 'log.md'),
  };
}

/** Project capture paths plus its shared global scope. Creates nothing. */
export function scopePaths(
  key: string
): WikiScope & { readonly projectDir: string; readonly globalDir: string } {
  const home = mehmoryHome();
  const projectDir = join(home, 'projects', key);
  return { ...wikiScope(projectDir), projectDir, globalDir: join(home, 'global') };
}

/** R2: an agent scope cannot address an inbox; captures always belong to a project. */
export interface AgentScopePaths {
  readonly agentDir: string;
  readonly identityFile: string;
  readonly indexFile: string;
  readonly pagesDir: string;
  readonly logFile: string;
}

/** Callers validate names before addressing an agent scope; creates nothing (R11). */
export function agentScopePaths(name: string): AgentScopePaths {
  if (!isSafeAgentName(name)) {
    throw new Error(`unsafe agent name "${name}" cannot address an agent scope`);
  }
  const agentDir = join(mehmoryHome(), 'agents', name);
  const scope = wikiScope(agentDir);
  return {
    agentDir,
    identityFile: scope.identityFile,
    indexFile: scope.indexFile,
    pagesDir: scope.pagesDir,
    logFile: scope.logFile,
  };
}

/** Thread the caller's decay horizon; omitting it leaves live pages fresh. */
export interface WikiReadOptions {
  readonly staleAfterDays?: number;
  readonly now?: number;
}

/** Raw text is retained for scoring/snippets; metadata is parsed once per read. */
export interface WikiPage {
  readonly path: string;
  readonly slug: string;
  readonly body: string;
  /** Lowercased filename plus first heading, preserving the existing scoring weight. */
  readonly title: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly decayClass: string;
  readonly updatedAt: number | null;
  readonly ageDays: number | null;
  readonly mtimeMs: number;
  readonly stale: boolean;
}

export interface WikiIndex {
  /** Missing, refused or unreadable files must not be rewritten by maintenance. */
  readonly readable: boolean;
  readonly body: string;
  /** Original zero-based line positions let writers reuse the parse. */
  readonly lines: readonly (IndexLine & { readonly demoted: boolean; readonly line: number })[];
}

/** Lazy, per-open snapshot: unused corpora are never scanned, each used part reads once. */
export interface Wiki {
  readonly scope: WikiScope;
  readonly pages: readonly WikiPage[];
  readonly pagesReadable: boolean;
  readonly archive: readonly WikiPage[];
  readonly index: WikiIndex;
  readonly identity: string;
  readonly project: string;
  readonly log: string;
}

function contained(root: string, candidate: string): boolean {
  const suffix = relative(realpath(resolve(root)), realpath(resolve(candidate)));
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function readIfPresent(path: string): string | undefined {
  return failOpen(
    () => {
      const candidate = resolve(path);
      if (!contained(mehmoryHome(), dirname(candidate)) || !pathExists(candidate)) return undefined;
      const info = lstat(candidate);
      return !info?.isSymbolicLink() && info?.isFile() === true ? readFile(candidate) : undefined;
    },
    undefined,
    'E_STORE_READ'
  );
}

interface PageRead {
  readonly pages: readonly WikiPage[];
  readonly readable: boolean;
}

function readPages(dir: string, options: WikiReadOptions, archived: boolean): PageRead {
  return failOpen(
    () => {
      if (!pathExists(dir) || lstat(dir)?.isSymbolicLink()) return { pages: [], readable: false };
      const pages: WikiPage[] = [];
      const now = options.now ?? Date.now();
      for (const name of listDir(dir)) {
        if (!name.endsWith('.md')) continue;
        const page = failOpen(
          () => {
            const path = resolve(dir, name);
            const info = lstat(path);
            if (info?.isSymbolicLink() || info?.isFile() !== true) return undefined;
            const body = readFile(path);
            const frontmatter = readFrontmatter(body);
            const updated = Date.parse(frontmatter['updated'] ?? '');
            const updatedAt = Number.isNaN(updated) ? null : updated;
            return {
              path,
              slug: name.slice(0, -3),
              body,
              title: `${name} ${/^#\s+(.*)$/m.exec(body)?.[1] ?? ''}`.toLowerCase(),
              frontmatter,
              decayClass: frontmatter['decay'] ?? 'default',
              updatedAt,
              ageDays: updatedAt === null ? null : (now - updatedAt) / MS_PER_DAY,
              mtimeMs: Number(info.mtimeMs),
              stale:
                archived ||
                (options.staleAfterDays !== undefined &&
                  isStalePage(frontmatter, now, options.staleAfterDays)),
            };
          },
          undefined,
          'E_STORE_READ'
        );
        if (page !== undefined) pages.push(page);
      }
      return { pages, readable: true };
    },
    { pages: [], readable: false },
    'E_STORE_READ'
  );
}

function readIndex(path: string): WikiIndex {
  const contents = readIfPresent(path);
  const body = contents ?? '';
  const lines: (IndexLine & { demoted: boolean; line: number })[] = [];
  let demoted = false;
  for (const [offset, line] of body.split('\n').entries()) {
    if (line.trim() === ARCHIVE_DIVIDER) demoted = true;
    const parsed = parseIndexLine(line);
    if (parsed !== undefined) lines.push({ ...parsed, demoted, line: offset });
  }
  return { readable: contents !== undefined, body, lines };
}

/** Read only requested parts, with one no-symlink/regular-file policy for every page. */
export function openScope(dir: string, options: WikiReadOptions = {}): Wiki {
  const scope = wikiScope(dir);
  let pages: PageRead | undefined;
  let archive: PageRead | undefined;
  let index: WikiIndex | undefined;
  let identity: string | undefined;
  let project: string | undefined;
  let log: string | undefined;
  return {
    scope,
    get pages() {
      return (pages ??= readPages(scope.pagesDir, options, false)).pages;
    },
    get pagesReadable() {
      return (pages ??= readPages(scope.pagesDir, options, false)).readable;
    },
    get archive() {
      return (archive ??= readPages(scope.archiveDir, options, true)).pages;
    },
    get index() {
      return (index ??= readIndex(scope.indexFile));
    },
    get identity() {
      return (identity ??= (readIfPresent(scope.identityFile) ?? '').trim());
    },
    get project() {
      return (project ??= (readIfPresent(scope.projectFile) ?? '').trim());
    },
    get log() {
      return (log ??= readIfPresent(scope.logFile) ?? '');
    },
  };
}

/**
 * Project reads use global identity. Pages and index fall back independently when
 * their project path is absent, not when it is empty or unreadable.
 */
export function openProjectWiki(key: string, options: WikiReadOptions = {}): Wiki {
  const paths = scopePaths(key);
  const project = openScope(paths.dir, options);
  const global = openScope(paths.globalDir, options);
  const sourceFor = (path: string): Wiki => (pathExists(path) ? project : global);
  return {
    scope: project.scope,
    get archive() {
      return project.archive;
    },
    get project() {
      return project.project;
    },
    get log() {
      return project.log;
    },
    get pages() {
      return sourceFor(paths.pagesDir).pages;
    },
    get pagesReadable() {
      return sourceFor(paths.pagesDir).pagesReadable;
    },
    get index() {
      return sourceFor(paths.indexFile).index;
    },
    get identity() {
      return global.identity;
    },
  };
}

/** All search scopes, including agents without an identity page (existing --all policy). */
export function listWikiTargets(): readonly { readonly label: string; readonly dir: string }[] {
  const agents = failOpen(
    () => {
      const root = join(mehmoryHome(), 'agents');
      if (!pathExists(root)) return [];
      return listDir(root)
        .filter((name) => isSafeAgentName(name) && stat(join(root, name))?.isDirectory() === true)
        .map((name) => ({ label: `agent/${name}`, dir: join(root, name) }));
    },
    [],
    'E_STORE_READ'
  );
  return [
    { label: 'global', dir: join(mehmoryHome(), 'global') },
    ...listProjects().map((p) => ({ label: p.key, dir: p.dir })),
    ...agents,
  ];
}

export function storeExists(): boolean {
  return pathExists(wikiScope(join(mehmoryHome(), 'global')).identityFile);
}

export function storeIsUnpopulated(key: string): boolean {
  const paths = scopePaths(key);
  const project = openScope(paths.dir);
  return (
    project.project === '' &&
    project.pages.length === 0 &&
    openScope(paths.globalDir).pages.length === 0
  );
}

/** Archival writes must stay inside the canonical scope, even for the exact parent. */
export function archivePage(scope: WikiScope, page: WikiPage): boolean {
  return failOpen(
    () => {
      if (pathExists(scope.archiveDir) && lstat(scope.archiveDir)?.isSymbolicLink()) {
        throw new Error('archive directory must not be a symlink');
      }
      mkdir(scope.archiveDir);
      if (!contained(scope.dir, scope.archiveDir)) {
        throw new Error('archive directory must remain inside the scope');
      }
      rename(page.path, join(scope.archiveDir, `${page.slug}.md`));
      return true;
    },
    false,
    'E_ATOMIC_WRITE'
  );
}
