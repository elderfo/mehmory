import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { jaccard, matchPages, tokenize } from '../src/core/match.js';
import { atomicWrite } from '../src/core/fs.js';
import { mehmoryHome } from '../src/core/home.js';

function pagesDir(scope: string): string {
  return join(mehmoryHome(), 'projects', scope, 'pages');
}

function writePage(scope: string, file: string, body: string): void {
  atomicWrite(join(pagesDir(scope), file), body);
}

describe('tokenize', () => {
  it('lowercases, drops short tokens and stopwords', () => {
    expect([...tokenize('The deploy Pipeline is a GO')]).toEqual(['deploy', 'pipeline']);
  });

  it('deduplicates', () => {
    expect(tokenize('deploy deploy deploy').size).toBe(1);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('is the intersection over the union', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(2 / 4);
  });

  it('treats two empty sets as identical', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });
});

describe('matchPages', () => {
  it('returns the pages whose text matches the prompt, best first', () => {
    writePage('m1', 'deploy.md', '# Deploy\n\nThe deploy pipeline runs on merge to main.\n');
    writePage('m1', 'testing.md', '# Testing\n\nVitest runs the suite.\n');
    writePage('m1', 'rollback.md', '# Rollback\n\nRollback reverts the deploy.\n');

    const paths = matchPages('how does deploy work', pagesDir('m1')).map(p => p.path);

    expect(paths[0]).toBe(join('pages', 'deploy.md'));
    expect(paths).toContain(join('pages', 'rollback.md'));
    expect(paths).not.toContain(join('pages', 'testing.md'));
  });

  it('returns nothing when no page matches', () => {
    writePage('m2', 'deploy.md', '# Deploy\n\npipeline notes\n');
    expect(matchPages('quantum entanglement harmonics', pagesDir('m2'))).toEqual([]);
  });

  it('caps the result at max (default 3)', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      writePage('m3', `page${String(n)}.md`, `# Page ${String(n)}\n\ndeploy deploy deploy\n`);
    }

    expect(matchPages('deploy', pagesDir('m3'))).toHaveLength(3);
    expect(matchPages('deploy', pagesDir('m3'), 1)).toHaveLength(1);
  });

  it('weights title and filename hits above body hits', () => {
    writePage('m4', 'rollback.md', '# Rollback\n\nshort note\n');
    writePage('m4', 'misc.md', '# Misc\n\nrollback is mentioned once here in the body\n');

    expect(matchPages('rollback', pagesDir('m4'))[0]?.path).toBe(join('pages', 'rollback.md'));
  });

  it('returns nothing for an empty prompt or a missing directory', () => {
    expect(matchPages('', pagesDir('m5'))).toEqual([]);
    expect(matchPages('deploy', pagesDir('does-not-exist'))).toEqual([]);
  });

  it('ignores non-markdown files', () => {
    writePage('m6', 'notes.txt', 'deploy deploy');
    expect(matchPages('deploy', pagesDir('m6'))).toEqual([]);
  });
});

describe('matchPages staleness (A22)', () => {
  const NOW = Date.parse('2026-08-01T00:00:00Z');
  const daysAgo = (n: number): string =>
    new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

  function writeDatedPage(scope: string, file: string, updated: string, body: string): void {
    writePage(scope, file, `---\nupdated: ${updated}\n---\n\n${body}`);
  }

  it('demotes a stale page but never drops it', () => {
    writeDatedPage('s1', 'old.md', daysAgo(200), '# Old\n\ndeploy deploy deploy deploy\n');

    const hits = matchPages('deploy', pagesDir('s1'), 3, { staleAfterDays: 60, now: NOW });

    // Kept — a stale answer still beats no answer — and flagged so the caller can say so.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.stale).toBe(true);
  });

  it('ranks a weaker fresh page above a stronger stale one once demoted', () => {
    // Stale page scores 4 raw hits, fresh scores 3. Demotion (×0.7 → 2.8) flips the order;
    // without it the stale page would win, which is the bug this rule exists to prevent.
    writeDatedPage('s2', 'stale.md', daysAgo(200), '# Notes\n\ndeploy deploy deploy deploy\n');
    writeDatedPage('s2', 'fresh.md', daysAgo(1), '# Notes\n\ndeploy deploy deploy\n');

    const hits = matchPages('deploy', pagesDir('s2'), 3, { staleAfterDays: 60, now: NOW });

    expect(hits.map(h => h.path)).toEqual([join('pages', 'fresh.md'), join('pages', 'stale.md')]);
    expect(hits[1]?.stale).toBe(true);
  });

  it('treats a page with no parseable `updated` as fresh, not stale', () => {
    writePage('s3', 'undated.md', '# Undated\n\ndeploy deploy\n');
    writeDatedPage('s4', 'bad.md', 'not-a-date', '# Bad\n\ndeploy deploy\n');

    expect(matchPages('deploy', pagesDir('s3'), 3, { staleAfterDays: 60, now: NOW })[0]?.stale).toBe(
      false
    );
    expect(matchPages('deploy', pagesDir('s4'), 3, { staleAfterDays: 60, now: NOW })[0]?.stale).toBe(
      false
    );
  });

  it('evaluates no staleness at all when the caller passes no horizon', () => {
    writeDatedPage('s5', 'old.md', daysAgo(500), '# Old\n\ndeploy deploy\n');

    const hits = matchPages('deploy', pagesDir('s5'), 3, { now: NOW });
    expect(hits[0]?.stale).toBe(false);
  });
});
