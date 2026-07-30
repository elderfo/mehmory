import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mehmoryHome, statePath } from '../src/core/home.js';

describe('mehmoryHome', () => {
  // Captured per test, not at module load: the setup file points MEHMORY_HOME at a
  // fresh temp dir before each test, and the hermetic guard requires it to be put back.
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MEHMORY_HOME;
    delete process.env.MEHMORY_HOME;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.MEHMORY_HOME = originalEnv;
    } else {
      delete process.env.MEHMORY_HOME;
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
