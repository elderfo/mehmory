/** Host resolution (issue #18): declared argument wins, environment is the fallback. */

import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_HOST, resolveHost } from '../src/core/host.js';

describe('resolveHost', () => {
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  afterEach(() => {
    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
  });

  it('uses the explicit argument when present', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    expect(resolveHost('claude-code')).toBe('claude-code');
    expect(resolveHost('some-other-harness')).toBe('some-other-harness');
  });

  it('trims whitespace off the argument', () => {
    expect(resolveHost('  claude-code  ')).toBe('claude-code');
  });

  it('falls back to environment detection when no argument is passed (A2)', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/some/plugin/root';
    expect(resolveHost(undefined)).toBe('claude-code');
  });

  it('falls back to the default host when neither an argument nor the environment says anything', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    expect(resolveHost(undefined)).toBe(DEFAULT_HOST);
    expect(resolveHost('')).toBe(DEFAULT_HOST);
    expect(resolveHost('   ')).toBe(DEFAULT_HOST);
  });
});
