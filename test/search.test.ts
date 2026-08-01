/**
 * `src/core/search.ts` — criterion 7. Core-level unit tests for the scan itself;
 * `test/cli-search.test.ts` covers the command that consumes it.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { searchScope } from '../src/core/search.js';

function seedScope(): { pagesDir: string; archiveDir: string; logFile: string } {
  const dir = createTempDir('mehmory-search-scope');
  const pagesDir = join(dir, 'pages');
  const archiveDir = join(dir, 'archive');
  mkdirSync(pagesDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  return { pagesDir, archiveDir, logFile: join(dir, 'log.md') };
}

describe('searchScope', () => {
  it('ranks a page where the term is meaningful above one where it merely appears', () => {
    const files = seedScope();
    // Alphabetically and by naive substring order, `aardvark.md` would sort first —
    // but the term barely appears in it, while `zephyr.md` is about it: the term is
    // in the title and repeated through the body. A ranking test that still puts
    // `aardvark.md` first would prove the scorer is really just naive order.
    writeFileSync(
      join(files.pagesDir, 'aardvark.md'),
      '# Unrelated notes\n\nSomewhere in a long page about other things, deployment ' +
        'is mentioned exactly once in passing and never again.\n' +
        'Filler line one.\nFiller line two.\nFiller line three.\n'
    );
    writeFileSync(
      join(files.pagesDir, 'zephyr.md'),
      '# Deployment runbook\n\nDeployment steps: deployment starts with deployment ' +
        'checks, then deployment proceeds, then deployment finishes.\n'
    );

    const scan = searchScope('deployment', 'proj', files);
    expect(scan.hits.map(h => h.path)).toEqual(['pages/zephyr.md', 'pages/aardvark.md']);
    expect(scan.hits[0]?.score).toBeGreaterThan(scan.hits[1]?.score ?? 0);
  });

  it('reaches a hit in log.md, the corpus matchPages cannot reach', () => {
    const files = seedScope();
    writeFileSync(
      files.logFile,
      '# Log\n\n## 2026-07-01T00:00:00.000Z integrate | rotated the staging credential\n'
    );
    const scan = searchScope('credential', 'proj', files);
    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]?.path).toBe('log.md');
    expect(scan.hits[0]?.snippet).toContain('credential');
  });

  it('finds a hit in archive/ as well as pages/', () => {
    const files = seedScope();
    writeFileSync(join(files.archiveDir, 'old.md'), '# Old topic\n\nwidget calibration notes\n');
    const scan = searchScope('widget', 'proj', files);
    expect(scan.hits.map(h => h.path)).toEqual(['archive/old.md']);
  });

  it('an empty result set is not an error: no hits, no warnings', () => {
    const files = seedScope();
    writeFileSync(join(files.pagesDir, 'a.md'), '# A\n\nnothing relevant here\n');
    const scan = searchScope('nonexistentterm', 'proj', files);
    expect(scan.hits).toEqual([]);
    expect(scan.warnings).toEqual([]);
  });

  it('ranks an archived page below an equally-matching live one, and flags it (A22)', () => {
    const files = seedScope();
    const body = '# Widget\n\nwidget widget widget\n';
    writeFileSync(join(files.pagesDir, 'live.md'), body);
    writeFileSync(join(files.archiveDir, 'old.md'), body);

    const scan = searchScope('widget', 'proj', files);

    // Identical text, so only the demotion can separate them — and neither is dropped.
    expect(scan.hits.map(h => h.path)).toEqual(['pages/live.md', 'archive/old.md']);
    expect(scan.hits[0]?.stale).toBe(false);
    expect(scan.hits[1]?.stale).toBe(true);
    expect(scan.hits[1]?.score).toBeLessThan(scan.hits[0]?.score ?? 0);
  });

  it('demotes a page aged past the horizon, and leaves log.md alone', () => {
    const files = seedScope();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const old = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(files.pagesDir, 'stale.md'),
      `---\nupdated: ${old}\n---\n\n# Widget\n\nwidget widget\n`
    );
    writeFileSync(files.logFile, '# Log\n\n## 2020-01-01T00:00:00.000Z integrate | widget\n');

    const scan = searchScope('widget', 'proj', files, { staleAfterDays: 60, now });
    const byPath = new Map(scan.hits.map(h => [h.path, h]));

    expect(byPath.get('pages/stale.md')?.stale).toBe(true);
    // The log records what happened; it cannot go out of date, so it is never demoted.
    expect(byPath.get('log.md')?.stale).toBe(false);
  });

  it('over the file cap, scans only the newest files and warns rather than truncating silently', () => {
    const files = seedScope();
    const now = Date.now();
    // Five files, decreasing mtime: widget-0 newest, widget-4 oldest.
    for (let i = 0; i < 5; i++) {
      const path = join(files.pagesDir, `widget-${String(i)}.md`);
      writeFileSync(path, `# Widget ${String(i)}\n\nwidget details\n`);
      const mtime = new Date(now - i * 1000);
      utimesSync(path, mtime, mtime);
    }

    const scan = searchScope('widget', 'proj', files, { fileCap: 2 });
    expect(scan.warnings).toEqual(['proj: scanned the newest 2 of 5 files (file cap)']);
    expect(scan.hits.map(h => h.path).sort()).toEqual(['pages/widget-0.md', 'pages/widget-1.md']);
  });
});
