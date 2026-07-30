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

    const hits = matchPages('how does deploy work', pagesDir('m1'));

    expect(hits[0]).toBe(join('pages', 'deploy.md'));
    expect(hits).toContain(join('pages', 'rollback.md'));
    expect(hits).not.toContain(join('pages', 'testing.md'));
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

    expect(matchPages('rollback', pagesDir('m4'))[0]).toBe(join('pages', 'rollback.md'));
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
