import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mehmoryHome, statePath } from '../src/core/home.js';

describe('mehmoryHome', () => {
  const originalEnv = process.env.MEHMORY_HOME;

  beforeEach(() => {
    delete process.env.MEHMORY_HOME;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.MEHMORY_HOME = originalEnv;
    }
  });

  it('returns MEHMORY_HOME when set', () => {
    process.env.MEHMORY_HOME = '/custom/path';
    expect(mehmoryHome()).toBe('/custom/path');
  });

  it('returns ~/.mehmory when MEHMORY_HOME is not set', () => {
    delete process.env.MEHMORY_HOME;
    const home = mehmoryHome();
    expect(home).toMatch(/\.mehmory$/);
  });
});

describe('statePath', () => {
  it('constructs path under .state directory', () => {
    const path = statePath('errors.log');
    expect(path).toMatch(/\.state[/\\]errors\.log$/);
  });

  it('handles multiple segments', () => {
    const path = statePath('dir', 'file.json');
    expect(path).toMatch(/\.state[/\\]dir[/\\]file\.json$/);
  });
});
