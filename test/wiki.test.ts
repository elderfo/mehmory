import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openProjectWiki,
  openScope,
  scopePaths,
  storeIsUnpopulated,
  listWikiTargets,
} from '../src/core/wiki.js';
import { mehmoryHome } from '../src/core/home.js';
import * as fs from '../src/core/fs.js';
import * as format from '../src/schema/format.js';
import { createTempDir } from './helpers.js';
import { errorsLog, seedStore } from './hook-fixture.js';

const KEY = 'wiki';
const NOW = Date.parse('2026-08-01T00:00:00Z');
const OPTIONS = { now: NOW, staleAfterDays: 60 };

afterEach(() => vi.restoreAllMocks());

describe('scope wiki reads', () => {
  it('reads only regular markdown pages, never page or corpus symlinks', () => {
    seedStore(KEY, { pages: { 'real.md': '# Deploy\ndeploy\n', 'notes.txt': 'not markdown' } });
    const scope = scopePaths(KEY);
    symlinkSync(join(scope.pagesDir, 'real.md'), join(scope.pagesDir, 'link.md'));
    mkdirSync(join(scope.pagesDir, 'directory.md'));
    expect(openScope(scope.dir).pages.map((p) => [p.slug, p.title, p.path])).toEqual([
      ['real', 'real.md deploy', join(scope.pagesDir, 'real.md')],
    ]);
    rmSync(scope.pagesDir, { recursive: true });
    const elsewhere = createTempDir('wiki-linked-pages');
    writeFileSync(join(elsewhere, 'outside.md'), 'deploy');
    symlinkSync(elsewhere, scope.pagesDir);
    symlinkSync(elsewhere, scope.archiveDir);
    expect(openScope(scope.dir).pages).toEqual([]);
    expect(openScope(scope.dir).archive).toEqual([]);
  });

  it('returns empty pages and logs E_STORE_READ when the corpus is a file', () => {
    seedStore(KEY);
    const scope = scopePaths(KEY);
    rmSync(scope.pagesDir, { recursive: true });
    writeFileSync(scope.pagesDir, 'deploy');
    expect(openScope(scope.dir).pages).toEqual([]);
    expect(errorsLog()).toContain('E_STORE_READ');
  });

  it('skips one unreadable page without losing readable siblings', () => {
    seedStore(KEY, { pages: { 'bad.md': 'deploy', 'good.md': 'deploy' } });
    const read = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation((path) => {
      if (path.endsWith('/bad.md')) throw new Error('unreadable');
      return read(path);
    });
    expect(openScope(scopePaths(KEY).dir).pages.map((p) => p.slug)).toEqual(['good']);
    expect(errorsLog()).toContain('E_STORE_READ');
  });

  it.each(['evergreen', 'ephemeral'])('keeps aged %s pages fresh', (decay) => {
    seedStore(KEY, {
      pages: { 'old.md': `---\nupdated: 2020-01-01\ndecay: ${decay}\n---\n# Notes\n` },
    });
    const page = openScope(scopePaths(KEY).dir, OPTIONS).pages[0];
    expect(page).toMatchObject({
      decayClass: decay,
      stale: false,
      title: 'old.md notes',
      frontmatter: { updated: '2020-01-01', decay },
      updatedAt: Date.parse('2020-01-01'),
    });
    expect(page?.ageDays).toBeGreaterThan(60);
  });

  it('uses raw ISO dates, strict age thresholds and the default decay class', () => {
    seedStore(KEY, {
      pages: {
        'old.md': '---\nupdated: 2020-01-01T00:00:00Z\n---\n# Old\n',
        'edge.md': '---\nupdated: 2026-06-02T00:00:00Z\n---\n# Edge\n',
        'undated.md': '# Undated\n',
        'invalid.md': '---\nupdated: not-a-date\n---\n',
      },
    });
    const pages = openScope(scopePaths(KEY).dir, OPTIONS).pages;
    expect(pages.map((p) => [p.slug, p.stale])).toEqual([
      ['edge', false],
      ['invalid', false],
      ['old', true],
      ['undated', false],
    ]);
    expect(pages.find((p) => p.slug === 'edge')?.ageDays).toBe(60);
    expect(pages.find((p) => p.slug === 'undated')?.updatedAt).toBeNull();
    expect(pages.find((p) => p.slug === 'invalid')?.ageDays).toBeNull();
    expect(openScope(scopePaths(KEY).dir).pages.every((p) => !p.stale)).toBe(true);
  });

  it('flags archive pages regardless of age or decay class', () => {
    seedStore(KEY);
    const scope = scopePaths(KEY);
    mkdirSync(scope.archiveDir);
    writeFileSync(join(scope.archiveDir, 'old.md'), '---\ndecay: evergreen\n---\n# Old\n');
    expect(openScope(scope.dir).archive[0]?.stale).toBe(true);
  });

  it('parses index entries once and records which are below the archive divider', () => {
    seedStore(KEY, { index: '# Index\nprose\n- [[live]] — current\n## Archive\n- [[old]]\n' });
    expect(openScope(scopePaths(KEY).dir).index.lines).toEqual([
      { slug: 'live', summary: 'current', demoted: false },
      { slug: 'old', summary: '', demoted: true },
    ]);
  });

  it('reads lazily and caches each requested part, parsing each page only once', () => {
    seedStore(KEY, { pages: { 'a.md': '# A\n' }, project: 'project' });
    const read = vi.spyOn(fs, 'readFile');
    const list = vi.spyOn(fs, 'listDir');
    const parse = vi.spyOn(format, 'readFrontmatter');
    const wiki = openProjectWiki(KEY, OPTIONS);
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(wiki.project).toBe('project');
    expect(wiki.project).toBe('project');
    expect(list).not.toHaveBeenCalled();
    expect(wiki.pages).toBe(wiki.pages);
    expect(wiki.index).toBe(wiki.index);
    expect(read.mock.calls.filter(([path]) => path.endsWith('/a.md'))).toHaveLength(1);
    expect(read.mock.calls.filter(([path]) => path.endsWith('/project.md'))).toHaveLength(1);
    expect(read.mock.calls.filter(([path]) => path.endsWith('/index.md'))).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('falls back independently for missing pages and index, not empty or unreadable paths', () => {
    seedStore(KEY, { pages: { 'local.md': '# Local' }, project: 'project' });
    const scope = scopePaths(KEY);
    writeFileSync(join(scope.globalDir, 'pages', 'shared.md'), '# Shared');
    writeFileSync(join(scope.globalDir, 'index.md'), '- [[shared]] — global');
    rmSync(scope.indexFile);
    expect(openProjectWiki(KEY).pages.map((p) => p.slug)).toEqual(['local']);
    expect(openProjectWiki(KEY).index.lines[0]?.slug).toBe('shared');
    writeFileSync(scope.indexFile, '');
    rmSync(scope.pagesDir, { recursive: true });
    expect(openProjectWiki(KEY).pages.map((p) => p.slug)).toEqual(['shared']);
    expect(openProjectWiki(KEY).index.body).toBe('');
    mkdirSync(scope.pagesDir);
    expect(openProjectWiki(KEY).pages).toEqual([]);
    rmSync(scope.pagesDir, { recursive: true });
    writeFileSync(scope.pagesDir, 'not a directory');
    expect(openProjectWiki(KEY).pages).toEqual([]);
    rmSync(scope.indexFile);
    mkdirSync(scope.indexFile);
    expect(openProjectWiki(KEY).index.body).toBe('');
  });

  it('contains single-file reads by canonical parent and refuses file symlinks', () => {
    seedStore(KEY, { project: 'safe' });
    const scope = scopePaths(KEY);
    expect(openProjectWiki(KEY).project).toBe('safe');
    const outside = createTempDir('wiki-outside');
    writeFileSync(join(outside, 'project.md'), 'outside');
    rmSync(scope.projectFile);
    symlinkSync(join(outside, 'project.md'), scope.projectFile);
    expect(openProjectWiki(KEY).project).toBe('');
    const linked = join(mehmoryHome(), 'projects', 'escape');
    symlinkSync(outside, linked);
    expect(openScope(linked).project).toBe('');
  });

  it('considers only readable pages or project content populated, in either scope', () => {
    seedStore(KEY, { project: '', pages: {} });
    const scope = scopePaths(KEY);
    mkdirSync(join(scope.pagesDir, 'directory.md'));
    symlinkSync(scope.indexFile, join(scope.pagesDir, 'link.md'));
    expect(storeIsUnpopulated(KEY)).toBe(true);
    writeFileSync(join(scope.globalDir, 'pages', 'shared.md'), '# Shared');
    expect(storeIsUnpopulated(KEY)).toBe(false);
  });

  it('lists search targets in core, including an agent without identity.md', () => {
    seedStore(KEY, { inboxEntries: 1 });
    const agent = join(mehmoryHome(), 'agents', 'scout');
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(mehmoryHome(), 'agents', 'invalid name'));
    expect(listWikiTargets()).toEqual([
      { label: 'global', dir: join(mehmoryHome(), 'global') },
      { label: KEY, dir: scopePaths(KEY).dir },
      { label: 'agent/scout', dir: agent },
    ]);
  });
});
