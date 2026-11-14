import { describe, it, expect } from 'vitest';
import { jaccard, matchPages, tokenize } from '../src/core/match.js';
import { page } from './wiki-fixture.js';

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
    const pages = [
      page('deploy', '# Deploy\nThe deploy pipeline runs on merge to main.\n', {
        title: 'deploy.md deploy',
      }),
      page('testing', '# Testing\nVitest runs the suite.\n'),
      page('rollback', '# Rollback\nRollback reverts the deploy.\n'),
    ];
    expect(matchPages('how does deploy work', pages).map((p) => p.path)).toEqual([
      '/wiki/pages/deploy.md',
      '/wiki/pages/rollback.md',
    ]);
  });
  it('returns nothing when no page matches', () => {
    expect(
      matchPages('quantum entanglement harmonics', [page('deploy', 'pipeline notes')])
    ).toEqual([]);
  });
  it('caps the result at max (default 3)', () => {
    const pages = [1, 2, 3, 4, 5].map((n) => page(`page${String(n)}`, 'deploy deploy deploy'));
    expect(matchPages('deploy', pages)).toHaveLength(3);
    expect(matchPages('deploy', pages, 1)).toHaveLength(1);
  });
  it('weights title and filename hits above body hits', () => {
    expect(
      matchPages('rollback', [
        page('rollback', 'short note', { title: 'rollback.md rollback' }),
        page('misc', 'rollback is mentioned once here in the body'),
      ])[0]?.path
    ).toBe('/wiki/pages/rollback.md');
  });
  it('returns nothing for an empty prompt or an empty wiki', () => {
    expect(matchPages('', [page('deploy', 'deploy')])).toEqual([]);
    expect(matchPages('deploy', [])).toEqual([]);
  });
  it('breaks equal scores by path', () => {
    expect(
      matchPages('deploy', [page('z', 'deploy'), page('a', 'deploy')]).map((p) => p.path)
    ).toEqual(['/wiki/pages/a.md', '/wiki/pages/z.md']);
  });
  it('demotes a stale page but never drops it', () => {
    expect(matchPages('deploy', [page('old', 'deploy', { stale: true })])).toEqual([
      { path: '/wiki/pages/old.md', stale: true },
    ]);
  });
  it('ranks a weaker fresh page above a stronger stale one once demoted', () => {
    expect(
      matchPages('deploy', [
        page('old', 'deploy deploy deploy deploy', { stale: true }),
        page('fresh', 'deploy deploy deploy'),
      ])
    ).toEqual([
      { path: '/wiki/pages/fresh.md', stale: false },
      { path: '/wiki/pages/old.md', stale: true },
    ]);
  });
});
