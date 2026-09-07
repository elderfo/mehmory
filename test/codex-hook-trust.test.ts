/**
 * The Codex hook-trust gate — issue #39.
 *
 * The reported symptom was "doctor reports all green, zero host=codex events ever". The
 * cause is not in mehmory's wiring at all: Codex refuses to run a registered hook until
 * the user has reviewed it, records that decision as
 * `[hooks.state."<hooks.json>:<event>:<group>:<index>"]` in `config.toml`, and skips
 * unreviewed hooks with no warning on any surface. Measured against Codex CLI 0.153.4:
 * sentinel hooks on every event fired zero times until `--dangerously-bypass-hook-trust`
 * was passed, at which point SessionStart, UserPromptSubmit, Stop and SessionEnd all
 * fired and no `[hooks.state]` had been written.
 *
 * So the fix is a diagnosis, not a behavior change: `doctor` has to be able to tell a
 * live install from a wired-but-never-approved one.
 */

import { describe, it, expect } from 'vitest';
import { readTrustedHookEvents } from '../src/core/codex-install.js';

const HOOKS_FILE = '/home/u/.codex/hooks.json';

/** The shape Codex writes after the user approves a hook. */
function trustEntry(event: string, group = 0, index = 0, body = 'trusted_hash = "sha256:abc"'): string {
  return `[hooks.state."${HOOKS_FILE}:${event}:${String(group)}:${String(index)}"]\n${body}\n`;
}

describe('readTrustedHookEvents', () => {
  it('reads back the events the user has approved', () => {
    const toml = `[features]\nhooks = true\n\n${trustEntry('session_start')}\n${trustEntry('stop')}`;
    expect([...readTrustedHookEvents(toml, HOOKS_FILE)].sort()).toEqual(['session_start', 'stop']);
  });

  it('finds nothing in the config of a fresh install', () => {
    expect(readTrustedHookEvents('[features]\nhooks = true\n', HOOKS_FILE)).toEqual([]);
  });

  it('ignores trust decisions about another tool s hooks file', () => {
    const foreign = `[hooks.state."context-mode@context-mode:.codex-plugin/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n`;
    expect(readTrustedHookEvents(foreign, HOOKS_FILE)).toEqual([]);
  });

  it('treats a reviewed-and-declined hook as untrusted, because it does not run either', () => {
    const toml = trustEntry('stop', 0, 0, 'enabled = false\ntrusted_hash = "sha256:abc"');
    expect(readTrustedHookEvents(toml, HOOKS_FILE)).toEqual([]);
  });

  it('does not let a later table s enabled = false disable an earlier entry', () => {
    const toml = `${trustEntry('stop')}\n[some.other.table]\nenabled = false\n`;
    expect(readTrustedHookEvents(toml, HOOKS_FILE)).toEqual(['stop']);
  });

  it('matches whatever group and hook indices mehmory s entries landed on', () => {
    expect(readTrustedHookEvents(trustEntry('pre_compact', 2, 1), HOOKS_FILE)).toEqual(['pre_compact']);
  });
});
