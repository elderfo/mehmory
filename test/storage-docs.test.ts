import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initStore } from '../src/core/store.js';
import { mehmoryHome } from '../src/core/home.js';

it('documents inbox escapes in both shipped schema copies and the one-way legacy upgrade', () => {
  expect(initStore().ok).toBe(true);
  for (const path of ['assets/SCHEMA.md', join(mehmoryHome(), 'SCHEMA.md')]) {
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('`\\\\`, `\\n`, `\\r`, and `--\\>` are escape sequences in entry text');
  }
  const upgrade = readFileSync('docs/UPGRADE.md', 'utf8');
  expect(upgrade).toContain('one-way');
  expect(upgrade).toContain('C:\\Users\\name\\repo');
  expect(readFileSync('CHANGELOG.md', 'utf8')).toContain('Legacy inbox');
});

it('records git bounds, timeout lock recovery, and fsync cost', () => {
  const model = readFileSync('docs/WORLD_MODEL.md', 'utf8');
  expect(model).toContain('500 ms');
  expect(model).toContain('10 s');
  expect(model).toContain('1–2 ms');
  const troubleshooting = readFileSync('docs/TROUBLESHOOTING.md', 'utf8');
  expect(troubleshooting).toContain('rm <store>/.git/index.lock');
  expect(troubleshooting).toContain('timeout');
});
