import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { treeDigest } from './cli-fixture.js';

describe('treeDigest', () => {
  it('ignores the empty locks directory but hashes leaked lock files', () => {
    const dir = createTempDir('mehmory-digest');
    mkdirSync(join(dir, '.state'));
    expect(treeDigest(dir)).toBe(
      'fe54651318cc667694cbf6e2576b530e383ce20ea533060a676ed30430d9be9a'
    );
    mkdirSync(join(dir, '.state', 'locks'));
    expect(treeDigest(dir)).toBe(
      'fe54651318cc667694cbf6e2576b530e383ce20ea533060a676ed30430d9be9a'
    );
    writeFileSync(join(dir, '.state', 'locks', 'leaked.lock'), 'owner');
    expect(treeDigest(dir)).toBe(
      'c1745dfa63fa0d9ad5692a9bd09286f12907aab1dafb6c68c2f1181379e87a30'
    );
  });
});
