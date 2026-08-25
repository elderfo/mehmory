import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { isSafeAgentName, resolveAgentName } from '../src/core/agent.js';
import { statePath } from '../src/core/home.js';

/** Contents of the store's errors.log ('' when nothing was logged). */
function errorsLog(): string {
  const path = statePath('errors.log');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

describe('isSafeAgentName', () => {
  it('accepts a lowercase single segment over the safe class', () => {
    expect(isSafeAgentName('scout')).toBe(true);
    expect(isSafeAgentName('scout_2.0-x')).toBe(true);
    expect(isSafeAgentName('scout-2.0')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isSafeAgentName('')).toBe(false);
  });

  it('rejects a 65-character name and accepts a 64-character one', () => {
    expect(isSafeAgentName('a'.repeat(64))).toBe(true);
    expect(isSafeAgentName('a'.repeat(65))).toBe(false);
  });

  it('rejects `.` and `..`', () => {
    expect(isSafeAgentName('.')).toBe(false);
    expect(isSafeAgentName('..')).toBe(false);
  });

  it('rejects path separators and traversal', () => {
    for (const name of ['a/b', '../a', 'a/../b', '\\a', 'a\\b', '/scout']) {
      expect(isSafeAgentName(name), name).toBe(false);
    }
  });

  it('rejects whitespace', () => {
    for (const name of ['my agent', ' scout', 'scout ', ' ']) {
      expect(isSafeAgentName(name), name).toBe(false);
    }
  });

  it('rejects uppercase', () => {
    expect(isSafeAgentName('Scout')).toBe(false);
    expect(isSafeAgentName('scout')).toBe(true);
  });

  it('rejects each reserved token', () => {
    for (const name of ['global', 'projects', 'agents', 'all']) {
      expect(isSafeAgentName(name), name).toBe(false);
    }
  });
});

describe('resolveAgentName', () => {
  it('resolves a valid MEHMORY_AGENT value', () => {
    expect(resolveAgentName('scout', '')).toBe('scout');
  });

  it('falls back to config.identity.agent when the environment is unset', () => {
    expect(resolveAgentName(undefined, 'archivist')).toBe('archivist');
  });

  it('prefers the environment value when both are set', () => {
    expect(resolveAgentName('scout', 'archivist')).toBe('scout');
  });

  it('resolves unnamed when neither is set', () => {
    expect(resolveAgentName(undefined, undefined)).toBeUndefined();
    expect(resolveAgentName('', '')).toBeUndefined();
  });

  it('resolves unnamed for a name that could escape the store root', () => {
    for (const name of ['a/b', '..', '.hidden', 'my agent', 'a\\b']) {
      expect(resolveAgentName(name, undefined), name).toBeUndefined();
    }
  });

  it('rejects `Scout` and accepts `scout`', () => {
    expect(resolveAgentName('Scout', undefined)).toBeUndefined();
    expect(resolveAgentName('scout', undefined)).toBe('scout');
  });

  it('resolves unnamed for each reserved token', () => {
    for (const name of ['global', 'projects', 'agents', 'all']) {
      expect(resolveAgentName(name, undefined), name).toBeUndefined();
    }
  });

  it('refuses an invalid environment name rather than falling through to config', () => {
    expect(resolveAgentName('../evil', 'archivist')).toBeUndefined();
  });

  it('warns naming the rejected value and MEHMORY_AGENT as its source', () => {
    expect(() => resolveAgentName('../evil', undefined)).not.toThrow();
    const log = errorsLog();
    expect(log).toContain('../evil');
    expect(log).toContain('MEHMORY_AGENT');
  });

  it('warns on a present-but-unusable config value rather than reading it as unset', () => {
    // `''`/`undefined`/`null` are the three spellings of "no agent" (JSON has no
    // `undefined`, so `null` is how a config file writes it). Anything else is a
    // declaration that failed, and silence there is the misconfiguration going unseen.
    for (const value of [false, 0] as unknown[]) {
      expect(resolveAgentName(undefined, value), JSON.stringify(value)).toBeUndefined();
      expect(errorsLog(), JSON.stringify(value)).toContain('config.identity.agent');
    }
  });

  it('reads null, empty string and undefined as unset, with no warning', () => {
    for (const value of [null, '', undefined] as unknown[]) {
      expect(resolveAgentName(undefined, value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('describes a rejected non-string readably, with the right article', () => {
    resolveAgentName(undefined, { name: 'scout' });
    expect(errorsLog()).toContain('an object');
    resolveAgentName(undefined, ['scout']);
    expect(errorsLog()).toContain('an array');
    expect(errorsLog()).not.toContain('a object');
  });

  it('degrades to unnamed instead of throwing on a non-string config value', () => {
    // `loadConfig()` deep-merges unvalidated JSON and casts, so `identity.agent` can be
    // any JSON value. A wrong type must take the same warn-and-degrade path as a badly
    // spelled name, not crash the caller (A2).
    for (const value of [42, true, ['scout'], { name: 'scout' }] as unknown[]) {
      const label = JSON.stringify(value);
      expect(() => resolveAgentName(undefined, value), label).not.toThrow();
      expect(resolveAgentName(undefined, value), label).toBeUndefined();
    }
  });

  it('warns naming the rejected value and config.identity.agent as its source', () => {
    expect(() => resolveAgentName(undefined, 'Scout')).not.toThrow();
    const log = errorsLog();
    expect(log).toContain('Scout');
    expect(log).toContain('config.identity.agent');
  });
});
