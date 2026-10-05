import { describe, it, expect } from 'vitest';
import { searchScope } from '../src/core/search.js';
import { page } from './wiki-fixture.js';

describe('searchScope', () => {
  it('ranks a meaningful title above an incidental body occurrence', () => {
    const scan = searchScope('deployment', 'proj', {
      pages: [
        page('aardvark', '# Unrelated notes\nSomewhere deployment is mentioned once.'),
        page('zephyr', '# Deployment runbook\nDeployment steps: deployment checks.', {
          title: 'zephyr.md deployment runbook',
        }),
      ],
      archive: [],
      log: '',
    });
    expect(scan.hits.map((h) => h.path)).toEqual(['pages/zephyr.md', 'pages/aardvark.md']);
    expect(scan.hits[0]?.score).toBeGreaterThan(scan.hits[1]?.score ?? 0);
  });
  it('reaches log.md, which matchPages cannot reach', () => {
    const scan = searchScope('credential', 'proj', {
      pages: [],
      archive: [],
      log: '# Log\n\n## 2026-07-01T00:00:00.000Z integrate | rotated the staging credential\n',
    });
    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]?.path).toBe('log.md');
    expect(scan.hits[0]?.snippet).toContain('credential');
  });
  it('finds a hit in archive/ as well as pages/', () => {
    const scan = searchScope('widget', 'proj', {
      pages: [],
      archive: [page('old', '# Old topic\nwidget calibration notes')],
      log: '',
    });
    expect(scan.hits.map((h) => h.path)).toEqual(['archive/old.md']);
  });
  it('an empty result is not an error', () => {
    expect(
      searchScope('nonexistentterm', 'proj', {
        pages: [page('a', 'nothing relevant')],
        archive: [],
        log: '',
      })
    ).toEqual({ hits: [], warnings: [] });
  });
  it('ranks an archived page below an equally-matching live one, and flags it', () => {
    const body = '# Widget\nwidget widget widget';
    const scan = searchScope('widget', 'proj', {
      pages: [page('live', body)],
      archive: [page('old', body)],
      log: '',
    });
    expect(scan.hits.map((h) => h.path)).toEqual(['pages/live.md', 'archive/old.md']);
    expect(scan.hits[0]?.stale).toBe(false);
    expect(scan.hits[1]?.stale).toBe(true);
    expect(scan.hits[1]?.score).toBeLessThan(scan.hits[0]?.score ?? 0);
  });
  it('demotes an aged page, rounds fractional scores, and leaves the log alone', () => {
    const scan = searchScope('widget', 'proj', {
      pages: [page('stale', 'widget widget', { stale: true })],
      archive: [],
      log: '## 2020-01-01T00:00:00Z integrate | widget',
    });
    const byPath = new Map(scan.hits.map((h) => [h.path, h]));
    expect(byPath.get('pages/stale.md')).toMatchObject({ score: 1.4, stale: true });
    expect(byPath.get('log.md')?.stale).toBe(false);
  });
  it('over the file cap, scans only newest pages/archive, warns, and keeps the log', () => {
    const scan = searchScope(
      'widget',
      'proj',
      {
        pages: [0, 2, 3, 4].map((i) =>
          page(`widget-${String(i)}`, 'widget details', { mtimeMs: 100 - i })
        ),
        archive: [page('widget-1', 'widget details', { mtimeMs: 99 })],
        log: 'widget',
      },
      { fileCap: 2 }
    );
    expect(scan.warnings).toEqual(['proj: scanned the newest 2 of 5 files (file cap)']);
    expect(scan.hits.map((h) => h.path).sort()).toEqual([
      'archive/widget-1.md',
      'log.md',
      'pages/widget-0.md',
    ]);
  });
});
