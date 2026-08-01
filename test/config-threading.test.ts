/**
 * Plan criterion 13: the three documented-but-dead config keys reach the code that
 * uses them, threaded as parameters rather than read ambiently.
 *
 * Each test sets a NON-DEFAULT value and observes behavior change — a key that is
 * plumbed through but changes nothing fails this criterion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
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
  errorsLog,
  keyFor,
  outputJson,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
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

    const second = runHook('stop', { session_id: 's1' }, { cwd });
    expect(outputJson(second)['decision']).toBe('block');
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
});
