import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from '../src/core/fs.js';
import { join } from 'node:path';
import { decayPass, readFrontmatter } from '../src/core/decay.js';
import { loadConfig } from '../src/core/config.js';
import { atomicWrite, mkdir, pathExists, readFile } from '../src/core/fs.js';
import { mehmoryHome } from '../src/core/home.js';
import { ARCHIVE_DIVIDER } from '../src/schema/format.js';

const NOW = Date.parse('2026-07-29T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString().slice(0, 10);
}

function scope(name: string): string {
  return join(mehmoryHome(), 'projects', name);
}

function writePage(scopeDir: string, file: string, days: number, decay?: string): void {
  const frontmatter = ['---', `updated: ${daysAgo(days)}`, 'type: decision'];
  if (decay) frontmatter.push(`decay: ${decay}`);
  frontmatter.push('---', '', `# ${file.replace('.md', '')}`, '');
  atomicWrite(join(scopeDir, 'pages', file), frontmatter.join('\n'));
}

function writeIndex(scopeDir: string, lines: string[]): void {
  atomicWrite(
    join(scopeDir, 'index.md'),
    ['---', `updated: ${daysAgo(0)}`, 'type: entity', '---', '', '# Index', '', ...lines, ''].join(
      '\n'
    )
  );
}

afterEach(() => vi.restoreAllMocks());

describe('decayPass', () => {
  it('does not archive when the destination resolves to exactly the scope parent', () => {
    const dir = scope('containment');
    writePage(dir, 'ancient.md', 120);
    writeIndex(dir, ['- [[ancient]] — keep inside the scope']);
    const realpath = fs.realpath;
    // A canonicalization race or mount can resolve an otherwise regular directory
    // elsewhere. Pin the exact parent case that the old relative-path check accepted.
    vi.spyOn(fs, 'realpath').mockImplementation((path) =>
      path === join(dir, 'archive') ? join(dir, '..') : realpath(path)
    );
    const result = decayPass(dir, loadConfig(), { now: NOW });
    expect(result.archived).toEqual([]);
    expect(pathExists(join(dir, 'pages', 'ancient.md'))).toBe(true);
    expect(readFile(join(dir, 'index.md'))).toContain('[[ancient]]');
  });
  it('re-sorts live index lines newest-updated first', () => {
    const dir = scope('sort');
    writePage(dir, 'old.md', 30);
    writePage(dir, 'new.md', 1);
    writePage(dir, 'mid.md', 10);
    writeIndex(dir, ['- [[old]] — older page', '- [[new]] — newest page', '- [[mid]] — middling']);

    const result = decayPass(dir, loadConfig(), { now: NOW });

    expect(result.demoted).toEqual([]);
    expect(result.archived).toEqual([]);
    const lines = readFile(join(dir, 'index.md'))
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- [[new]] — newest page',
      '- [[mid]] — middling',
      '- [[old]] — older page',
    ]);
  });

  it('demotes pages older than 60d below the Archive divider', () => {
    const dir = scope('demote');
    writePage(dir, 'fresh.md', 5);
    writePage(dir, 'aged.md', 70);
    writeIndex(dir, ['- [[fresh]] — current', '- [[aged]] — stale but kept']);

    const result = decayPass(dir, loadConfig(), { now: NOW });

    expect(result.demoted).toEqual(['aged.md']);
    const content = readFile(join(dir, 'index.md'));
    expect(content.indexOf('[[fresh]]')).toBeLessThan(content.indexOf(ARCHIVE_DIVIDER));
    expect(content.indexOf(ARCHIVE_DIVIDER)).toBeLessThan(content.indexOf('[[aged]]'));
    // Demotion is index-only: the page file stays put.
    expect(pathExists(join(dir, 'pages', 'aged.md'))).toBe(true);
  });

  it('moves pages older than 90d into archive/ and drops their index line', () => {
    const dir = scope('archive');
    writePage(dir, 'ancient.md', 120);
    writePage(dir, 'fresh.md', 2);
    writeIndex(dir, ['- [[ancient]] — long gone', '- [[fresh]] — current']);

    const result = decayPass(dir, loadConfig(), { now: NOW });

    expect(result.archived).toEqual(['ancient.md']);
    expect(pathExists(join(dir, 'pages', 'ancient.md'))).toBe(false);
    expect(pathExists(join(dir, 'archive', 'ancient.md'))).toBe(true);
    expect(readFile(join(dir, 'index.md'))).not.toContain('[[ancient]]');
    expect(readFile(join(dir, 'index.md'))).toContain('[[fresh]]');
  });

  it('uses parsed index positions while preserving prose that mentions an archived page', () => {
    const dir = scope('parsed-index');
    writePage(dir, 'ancient.md', 120);
    writePage(dir, 'fresh.md', 2);
    writeIndex(dir, [
      'Notes mention [[ancient]] but are not an index line.',
      '  - [[ancient]] — remove this entry',
      '- [[fresh]] — current',
    ]);
    expect(decayPass(dir, loadConfig(), { now: NOW }).archived).toEqual(['ancient.md']);
    const content = readFile(join(dir, 'index.md'));
    expect(content).toContain('Notes mention [[ancient]] but are not an index line.');
    expect(content).not.toContain('remove this entry');
    expect(content).toContain('- [[fresh]] — current');
  });

  it('leaves evergreen and ephemeral pages alone however old they are', () => {
    const dir = scope('classes');
    writePage(dir, 'forever.md', 400, 'evergreen');
    writePage(dir, 'scratch.md', 400, 'ephemeral');
    writePage(dir, 'normal.md', 400);
    writeIndex(dir, ['- [[forever]]', '- [[scratch]]', '- [[normal]]']);

    const result = decayPass(dir, loadConfig(), { now: NOW });

    expect(result.archived).toEqual(['normal.md']);
    expect(pathExists(join(dir, 'pages', 'forever.md'))).toBe(true);
    expect(pathExists(join(dir, 'pages', 'scratch.md'))).toBe(true);
    const content = readFile(join(dir, 'index.md'));
    expect(content).toContain('[[forever]]');
    expect(content).toContain('[[scratch]]');
    expect(content).not.toContain('[[normal]]');
  });

  it('keeps the index preamble and is idempotent', () => {
    const dir = scope('idempotent');
    writePage(dir, 'aged.md', 70);
    writePage(dir, 'fresh.md', 1);
    writeIndex(dir, ['- [[aged]]', '- [[fresh]]']);

    decayPass(dir, loadConfig(), { now: NOW });
    const first = readFile(join(dir, 'index.md'));

    const second = decayPass(dir, loadConfig(), { now: NOW });
    expect(second.rewroteIndex).toBe(false);
    expect(readFile(join(dir, 'index.md'))).toBe(first);
    expect(first).toContain('# Index');
    expect(readFrontmatter(first)['type']).toBe('entity');
  });

  it('preserves index normalization when an existing pages directory is empty', () => {
    const dir = scope('empty-pages');
    mkdir(join(dir, 'pages'));
    atomicWrite(join(dir, 'index.md'), '# Index\n\n\n');
    expect(decayPass(dir, loadConfig(), { now: NOW }).rewroteIndex).toBe(true);
    expect(readFile(join(dir, 'index.md'))).toBe('# Index\n');
  });

  it('is a no-op on a scope with no pages directory', () => {
    expect(decayPass(scope('empty'), loadConfig(), { now: NOW })).toEqual({
      demoted: [],
      archived: [],
      rewroteIndex: false,
    });
  });

  it('ignores pages with no parseable updated date', () => {
    const dir = scope('undated');
    atomicWrite(join(dir, 'pages', 'nodate.md'), '# no frontmatter at all\n');
    writeIndex(dir, ['- [[nodate]]']);

    const result = decayPass(dir, loadConfig(), { now: NOW });

    expect(result.archived).toEqual([]);
    expect(result.demoted).toEqual([]);
    expect(pathExists(join(dir, 'pages', 'nodate.md'))).toBe(true);
  });
});

describe('readFrontmatter', () => {
  it('parses keys and stops at the closing divider', () => {
    const fields = readFrontmatter('---\nupdated: 2026-07-29\ntype: gotcha\n---\n\nbody: nope\n');
    expect(fields).toEqual({ updated: '2026-07-29', type: 'gotcha' });
  });

  it('returns nothing when there is no frontmatter', () => {
    expect(readFrontmatter('# just a page\n')).toEqual({});
  });
});
