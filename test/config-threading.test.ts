/**
 * Plan criterion 13: the three documented-but-dead config keys reach the code that
 * uses them, threaded as parameters rather than read ambiently.
 *
 * Each test sets a NON-DEFAULT value and observes behavior change — a key that is
 * plumbed through but changes nothing fails this criterion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mehmoryHome } from '../src/core/home.js';
import { loadConfig } from '../src/core/config.js';
import { redact } from '../src/core/redact.js';
import { buildInjection } from '../src/core/injection.js';
import { buildScopeInjection } from '../src/core/capture.js';
import { INJECTION_BUDGET_TOKENS } from '../src/core/tokens.js';
import { initStore } from '../src/core/store.js';
import { createTempDir, hermeticEnv } from './helpers.js';
import {
  additionalContext,
  errorsLog,
  keyFor,
  outputJson,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeCodexRollout,
} from './hook-fixture.js';

/** Overwrite the store's config.json (initStore writes an empty one). */
function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(mehmoryHome(), { recursive: true });
  writeFileSync(join(mehmoryHome(), 'config.json'), JSON.stringify(config));
}

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

describe('injection.budget_tokens reaches buildInjection', () => {
  const longIndex = 'index detail. '.repeat(400);

  it('defaults to the 800-token budget', () => {
    const frame = buildInjection([{ label: 'index', content: longIndex }]);
    expect(frame.totalTokens).toBeGreaterThan(100);
    expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
  });

  it('honors a lowered budget passed as a parameter', () => {
    const frame = buildInjection([{ label: 'index', content: longIndex }], {
      budgetTokens: 100,
    });
    expect(frame.totalTokens).toBeLessThanOrEqual(100);
  });

  it('carries config.injection.budget_tokens through buildScopeInjection', () => {
    const key = 'github.com/acme/widgets';
    seedStore(key, { index: `# Index\n\n${longIndex}` });

    const wide = buildScopeInjection(key).tokens;

    writeConfig({ injection: { budget_tokens: 120 } });
    const narrow = buildScopeInjection(key, loadConfig()).tokens;

    expect(narrow).toBeLessThan(wide);
    // The framing wrapper is added after truncation, so compare the budgeted body.
    expect(narrow).toBeLessThan(300);
  });
});

describe('secrets.patterns reaches redact', () => {
  it('redacts a user pattern that the built-in corpus does not catch', () => {
    const text = 'internal token INT-9f3a2b7c is here';
    expect(redact(text)).toContain('INT-9f3a2b7c');

    writeConfig({ secrets: { patterns: ['/INT-[0-9a-f]{8}/g'] } });
    const result = redact(text, loadConfig().secrets);

    expect(result).not.toContain('INT-9f3a2b7c');
    expect(result).toContain('[REDACTED]');
  });

  it('keeps the built-in patterns in force — user patterns are additive', () => {
    writeConfig({ secrets: { patterns: ['/INT-[0-9a-f]{8}/g'] } });
    const result = redact(`${AWS_KEY} and INT-9f3a2b7c`, loadConfig().secrets);
    expect(result).not.toContain(AWS_KEY);
    expect(result).not.toContain('INT-9f3a2b7c');
  });

  it('logs and skips a malformed pattern instead of throwing (A2)', () => {
    initStore();
    writeConfig({ secrets: { patterns: ['/unclosed(/', 'not-a-regex-at-all'] } });

    const secrets = loadConfig().secrets;
    let result = '';
    expect(() => (result = redact(`${AWS_KEY} stays filtered`, secrets))).not.toThrow();

    // The built-in corpus still applies despite the bad user pattern.
    expect(result).not.toContain(AWS_KEY);
    expect(errorsLog()).toContain('E_CONFIG_PARSE');
  });
});

describe('secrets.whitelist reaches redact', () => {
  it('exempts a whitelisted literal that a built-in pattern would redact', () => {
    expect(redact(`key ${AWS_KEY} here`)).not.toContain(AWS_KEY);

    writeConfig({ secrets: { whitelist: [AWS_KEY] } });
    const result = redact(`key ${AWS_KEY} here`, loadConfig().secrets);

    expect(result).toContain(AWS_KEY);
    expect(result).not.toContain('[REDACTED]');
  });

  // Regression: the first implementation split the text at whitelisted literals and
  // redacted the gaps, which broke the pattern's contiguous match and leaked the
  // WHOLE secret. A whitelist entry overlapping a secret must never shrink what the
  // built-in patterns catch — redaction wins on any partial overlap.
  it('redacts a secret when a whitelist entry is only a fragment of it', () => {
    const result = redact(`key ${AWS_KEY} here`, { whitelist: ['FODNN7'] });
    expect(result).toBe('key [REDACTED] here');
    expect(result).not.toContain(AWS_KEY);
  });

  it('redacts a multi-line private key when a whitelist entry sits inside it', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxSAFE_LITERALyGkQ',
      'nOtRealKeyMaterialAtAll1234567890',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const result = redact(`before\n${block}\nafter`, { whitelist: ['SAFE_LITERAL'] });

    expect(result).toBe('before\n[REDACTED]\nafter');
    for (const fragment of ['BEGIN RSA', 'MIIEowIBAAK', 'nOtRealKeyMaterial', 'SAFE_LITERAL']) {
      expect(result).not.toContain(fragment);
    }
  });

  it('still redacts non-whitelisted secrets in the same text', () => {
    writeConfig({ secrets: { whitelist: [AWS_KEY] } });
    const result = redact(
      `${AWS_KEY} and ghp_${'a'.repeat(36)}`,
      loadConfig().secrets
    );
    expect(result).toContain(AWS_KEY);
    expect(result).toContain('[REDACTED]');
  });
});

describe('stop.capture_threshold reaches the Stop hook', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
  });

  it('blocks at the configured threshold, not the built-in 15', () => {
    expect(loadConfig().stop.capture_threshold).toBe(15);
    writeConfig({ stop: { capture_threshold: 2 } });
    expect(loadConfig().stop.capture_threshold).toBe(2);

    const first = runHook('stop', { session_id: 's1' }, { cwd });
    expect(first.stdout).toBe('{}');

    // Claude Code's block shape is `hookSpecificOutput.additionalContext` — it blocks
    // like `decision: block` without rendering as a hook error. What matters here is
    // that the threshold fired, not which envelope carried it.
    const second = runHook('stop', { session_id: 's1' }, { cwd });
    expect(outputJson(second)['hookSpecificOutput']).toMatchObject({ hookEventName: 'Stop' });
  });
});

describe('hosts.<host>.enabled reaches runHook (issue #25)', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
  });

  const remember = (host: string): ReturnType<typeof runHook> =>
    runHook(
      'user-prompt-submit',
      { session_id: 's1', prompt: 'remember: a durable decision from this session' },
      { cwd, args: [host] }
    );

  it('a disabled harness captures nothing and stays silent, but still records a stat', () => {
    writeConfig({ hosts: { codex: { enabled: false } } });

    const run = remember('codex');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('');
    expect(readIfPresent(join(mehmoryHome(), 'projects', key, 'inbox.md'))).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'UserPromptSubmit', host: 'codex' });
  });

  it('leaves the other harness capturing normally', () => {
    writeConfig({ hosts: { codex: { enabled: false } } });

    const run = remember('claude-code');
    expect(run.status).toBe(0);
    expect(readIfPresent(join(mehmoryHome(), 'projects', key, 'inbox.md'))).toContain(
      'a durable decision'
    );
  });

  it('captures normally for both harnesses on the untouched default', () => {
    expect(remember('codex').stdout).toContain('captured to inbox');
  });
});

describe('hosts.<host>.enabled reaches injection too, not only capture (D10)', () => {
  // The suite above only exercised the toggle against capture. Injection is a separate
  // code path (SessionStart's context frame, UserPromptSubmit's pointer nudge) and needs
  // its own proof that a disabled harness gets neither.
  const CODEX_SESSION = '019fbf44-4f17-7a53-8914-1002bc65fbae';
  const DEPLOY_PAGE = `---
updated: 2026-07-01
type: procedure
---

# Deployment runbook

- deployment runs through the fly.io pipeline
`;

  let cwd: string;
  let key: string;
  let rollout: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, { pages: { 'deployment.md': DEPLOY_PAGE } });
    rollout = writeCodexRollout([{ text: 'we use fly.io' }], CODEX_SESSION);
  });

  it('suppresses session-start injection when codex is disabled', () => {
    writeConfig({ hosts: { codex: { enabled: false } } });

    const run = runHook(
      'session-start',
      { session_id: CODEX_SESSION, transcript_path: rollout, cwd, hook_event_name: 'SessionStart' },
      { cwd, args: ['codex', '--mehmory'] }
    );
    expect(run.status).toBe(0);
    expect(additionalContext(run)).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'SessionStart', host: 'codex' });
  });

  it('suppresses prompt-submit pointer injection when codex is disabled', () => {
    writeConfig({ hosts: { codex: { enabled: false } } });

    const run = runHook(
      'user-prompt-submit',
      {
        session_id: CODEX_SESSION,
        transcript_path: rollout,
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'how does deployment work?',
      },
      { cwd, args: ['codex', '--mehmory'] }
    );
    expect(run.status).toBe(0);
    expect(additionalContext(run)).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'UserPromptSubmit', host: 'codex' });
  });

  it('converse: claude-code still injects when only codex is disabled', () => {
    writeConfig({ hosts: { codex: { enabled: false } } });

    const run = runHook(
      'session-start',
      { session_id: CODEX_SESSION, transcript_path: rollout, cwd, hook_event_name: 'SessionStart' },
      { cwd, args: ['claude-code'] }
    );
    expect(run.status).toBe(0);
    expect(additionalContext(run)).toContain('<mehmory-memory>');
  });
});

describe('config is threaded, not re-read on the hot path', () => {
  it('redact and buildInjection accept config and never load it themselves', () => {
    // A store that does not exist at all: if either function reached for config.json
    // it would fault or fall back here rather than using what it was handed.
    const empty = createTempDir('mehmory-absent');
    process.env.MEHMORY_HOME = join(empty, 'nope');

    expect(redact(`${AWS_KEY} x`, { patterns: ['/x$/'] })).not.toContain(AWS_KEY);
    expect(
      buildInjection([{ label: 'index', content: 'x'.repeat(4000) }], {
        budgetTokens: 50,
      }).totalTokens
    ).toBeLessThanOrEqual(50);

    // Restore a hermetic home for the setup.ts afterEach guard.
    process.env.MEHMORY_HOME = empty;
    expect(hermeticEnv().MEHMORY_HOME).toBe(empty);
  });

  // Regression for F5-1/F5-2 (PR review, run 5): two earlier rounds threaded config
  // into some hooks and missed others, because `= loadConfig()` type-checks whether or
  // not a call site passes the argument — nothing here forces the compiler to catch a
  // reintroduced ambient read. `runHook` loads config once to check the per-harness
  // toggle and hands that object to every adapter (src/core/hook.ts); an adapter that
  // calls `loadConfig()` again duplicates the disk read on every hook invocation and
  // can disagree with the toggle `runHook` already evaluated. This can't be asserted by
  // running a hook and diffing output — a second read of the same unchanged file
  // returns the same config, so the observable behavior is identical either way. What
  // *is* checkable is the source itself: none of the five `runHook`-based adapters
  // should reference `loadConfig` at all once the fix lands.
  it('no runHook-based hook adapter calls loadConfig itself', () => {
    const adapters = [
      'pre-compact.ts',
      'session-end.ts',
      'session-start.ts',
      'stop.ts',
      'user-prompt-submit.ts',
    ];
    for (const file of adapters) {
      const source = readFileSync(join(process.cwd(), 'src', 'hooks', file), 'utf-8');
      expect(source, file).not.toMatch(/\bloadConfig\b/);
    }
  });
});
