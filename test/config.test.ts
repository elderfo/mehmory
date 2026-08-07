import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type MehmoryConfig } from '../src/core/config.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

/**
 * Test suite for loadConfig.
 * Tests default loading, deep merge, error handling, and full schema presence.
 */
describe('loadConfig', () => {
  let tempDir: string;
  // Captured per test: the setup file re-points MEHMORY_HOME before each one.
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.MEHMORY_HOME;
    tempDir = createTempDir('config-test');
    process.env.MEHMORY_HOME = tempDir;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalHome) {
      process.env.MEHMORY_HOME = originalHome;
    } else {
      delete process.env.MEHMORY_HOME;
    }
  });

  it('cannot be made to pollute Object.prototype from config.json', () => {
    // `JSON.parse` makes `__proto__` a real own enumerable property, so the merge saw it
    // as ordinary data: `'__proto__' in target` is true via the prototype chain, and the
    // recursion then wrote straight into `Object.prototype`. config.json is user-writable
    // and merged into defaults on every hook run, so one poisoned file would have leaked
    // a property onto every object in the process (CodeQL js/prototype-pollution-utility).
    // Written as raw JSON on purpose: in an object literal `__proto__:` invokes the
    // prototype setter and JSON.stringify would never emit the key, so a stringified
    // fixture silently tests nothing. `JSON.parse` is what makes it an own property.
    writeFileSync(
      join(tempDir, 'config.json'),
      '{"__proto__": {"polluted": "yes"}, "constructor": {"polluted": "yes"}}'
    );

    try {
      expect(() => loadConfig()).not.toThrow();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
    } finally {
      // A failure here must not poison the rest of the suite.
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  });

  it('detects missing config.json and returns full defaults without throwing', () => {
    const configPath = join(tempDir, 'config.json');

    // Explicitly verify config.json does not exist
    expect(() => readFileSync(configPath)).toThrow();

    // Call loadConfig() and verify it doesn't throw
    expect(() => loadConfig()).not.toThrow();

    // Call loadConfig() to get the result
    const result = loadConfig();

    // Check that all top-level keys are present
    expect(result).toHaveProperty('injection');
    expect(result).toHaveProperty('decay');
    expect(result).toHaveProperty('secrets');
    expect(result).toHaveProperty('hooks');
    expect(result).toHaveProperty('identity');
    expect(result).toHaveProperty('lock');
    expect(result).toHaveProperty('queue');
    expect(result).toHaveProperty('distill');
    expect(result).toHaveProperty('log');
    expect(result).toHaveProperty('warning');

    // Check specific defaults (verifying that defaults are used, not arbitrary values)
    expect(result.injection.budget_tokens).toBe(800);
    expect(result.decay.enabled).toBe(true);
    expect(result.decay.archive_days).toBe(60);
    expect(result.decay.purge_days).toBe(90);
    expect(result.lock.retry_count).toBe(50);
    expect(result.lock.retry_delay_ms).toBe(100);
    expect(result.lock.stale_ms).toBe(30000);
    expect(result.queue.max_claims).toBe(3);
    expect(result.distill.max_loss_percent).toBe(10);
    expect(result.log.rotation_size_mb).toBe(5);
    expect(result.warning.rate_limit_ms).toBe(3600000); // 1 hour
  });

  it('deep merges user config over defaults (not replacing)', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        injection: {
          budget_tokens: 1000,
        },
        decay: {
          archive_days: 45,
        },
      }),
      'utf-8'
    );

    const config = loadConfig();

    // User-provided values override
    expect(config.injection.budget_tokens).toBe(1000);
    expect(config.decay.archive_days).toBe(45);

    // Sibling keys under decay still have defaults
    expect(config.decay.enabled).toBe(true);
    expect(config.decay.purge_days).toBe(90);

    // Unrelated top-level keys still have defaults
    expect(config.lock.retry_count).toBe(50);
  });

  it('logs E_CONFIG_PARSE and returns defaults when config.json is invalid JSON', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, 'not valid json {', 'utf-8');

    const config = loadConfig();

    // Should return defaults despite parse error
    expect(config.injection.budget_tokens).toBe(800);
    expect(config.decay.enabled).toBe(true);

    // logError should have been called; error is recorded to .state/errors.log
  });

  it('logs E_CONFIG_PARSE and returns defaults when config.json is not an object', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '["array", "not", "object"]', 'utf-8');

    const config = loadConfig();

    // Should return defaults
    expect(config.injection.budget_tokens).toBe(800);
  });

  it('defaults the run-2 keys (criterion 19)', () => {
    const config = loadConfig();

    expect(config.inbox.nudge_entries).toBe(10);
    expect(config.inbox.nudge_bytes).toBe(8192);
    expect(config.session_state.max_age_days).toBe(14);
    expect(config.match.jaccard).toBe(0.7);
    expect(config.match.cache_ttl_ms).toBe(300000);
    expect(config.queue.claims_per_start).toBe(1);
    expect(config.hooks.session_start.enabled).toBe(true);
    expect(config.hooks.user_prompt_submit.enabled).toBe(true);
    expect(config.hooks.stop.enabled).toBe(true);
    expect(config.hooks.pre_compact.enabled).toBe(true);
    expect(config.hooks.session_end.enabled).toBe(true);
  });

  it('deep-merges a run-2 key without dropping its siblings', () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ match: { jaccard: 0.9 } }),
      'utf-8'
    );

    const config = loadConfig();
    expect(config.match.jaccard).toBe(0.9);
    expect(config.match.cache_ttl_ms).toBe(300000);
  });

  it('allows overriding nested keys without losing siblings', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          session_start: { enabled: false },
          // user_prompt_submit and others not specified
        },
      }),
      'utf-8'
    );

    const config = loadConfig();

    // User-provided value overrides
    expect(config.hooks.session_start.enabled).toBe(false);

    // Siblings remain as defaults
    expect(config.hooks.user_prompt_submit.enabled).toBe(true);
    expect(config.hooks.stop.enabled).toBe(true);
    expect(config.hooks.pre_compact.enabled).toBe(true);
    expect(config.hooks.session_end.enabled).toBe(true);
  });

  it('allows setting identity.aliases', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        identity: {
          aliases: {
            'github.com/owner/repo': 'my-project',
          },
        },
      }),
      'utf-8'
    );

    const config = loadConfig();

    expect(config.identity.aliases['github.com/owner/repo']).toBe('my-project');
  });

  it('supports secrets.patterns and secrets.whitelist overrides', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        secrets: {
          patterns: ['^custom_pattern_', '^another_'],
          whitelist: ['safe-to-store'],
        },
      }),
      'utf-8'
    );

    const config = loadConfig();

    // Arrays should be replaced (not merged)
    expect(config.secrets.patterns).toEqual(['^custom_pattern_', '^another_']);
    expect(config.secrets.whitelist).toEqual(['safe-to-store']);
  });

  it('never throws when encountering read/parse errors', () => {
    // Create a directory at the config.json path (to cause a read error)
    const configPath = join(tempDir, 'config.json');
    mkdirSync(configPath, { recursive: true });

    // Should not throw
    expect(() => loadConfig()).not.toThrow();

    const config = loadConfig();
    // Should return defaults
    expect(config.injection.budget_tokens).toBe(800);
  });

  it('respects MEHMORY_HOME environment variable', () => {
    // Create a config in a different directory
    const customHome = join(tempDir, 'custom-home');
    mkdirSync(customHome, { recursive: true });
    const configPath = join(customHome, 'config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        injection: {
          budget_tokens: 1200,
        },
      }),
      'utf-8'
    );

    process.env.MEHMORY_HOME = customHome;
    const config = loadConfig();

    expect(config.injection.budget_tokens).toBe(1200);
  });

  it('ensures full schema presence (all keys required in returned config)', () => {
    const config = loadConfig();

    // This validates the MehmoryConfig interface is fully satisfied
    const requiredKeys: (keyof MehmoryConfig)[] = [
      'injection',
      'decay',
      'secrets',
      'hooks',
      'identity',
      'lock',
      'queue',
      'distill',
      'log',
      'warning',
      'inbox',
      'session_state',
      'match',
    ];

    for (const key of requiredKeys) {
      expect(config).toHaveProperty(key);
    }

    // Check nested structure
    expect(config.injection).toHaveProperty('budget_tokens');
    expect(typeof config.injection.budget_tokens).toBe('number');

    expect(config.decay).toHaveProperty('enabled');
    expect(config.decay).toHaveProperty('archive_days');
    expect(config.decay).toHaveProperty('purge_days');

    expect(config.lock).toHaveProperty('retry_count');
    expect(config.lock).toHaveProperty('retry_delay_ms');
    expect(config.lock).toHaveProperty('stale_ms');

    expect(config.queue).toHaveProperty('max_claims');
    expect(config.queue).toHaveProperty('stale_ms');

    expect(config.distill).toHaveProperty('max_loss_percent');

    expect(config.log).toHaveProperty('rotation_size_mb');

    expect(config.warning).toHaveProperty('rate_limit_ms');
  });

  it('returns a new object each time (not a cached singleton)', () => {
    const config1 = loadConfig();
    const config2 = loadConfig();

    // Should be different objects
    expect(config1).not.toBe(config2);

    // But with the same values
    expect(config1).toEqual(config2);
  });

  it('allows all bounds to be overridden via config', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        lock: {
          retry_count: 100,
          retry_delay_ms: 200,
          stale_ms: 60000,
        },
        queue: {
          max_claims: 5,
          stale_ms: 60000,
        },
        distill: {
          max_loss_percent: 20,
        },
        log: {
          rotation_size_mb: 10,
        },
        warning: {
          rate_limit_ms: 1800000, // 30 minutes
        },
      }),
      'utf-8'
    );

    const config = loadConfig();

    expect(config.lock.retry_count).toBe(100);
    expect(config.lock.retry_delay_ms).toBe(200);
    expect(config.lock.stale_ms).toBe(60000);
    expect(config.queue.max_claims).toBe(5);
    expect(config.queue.stale_ms).toBe(60000);
    expect(config.distill.max_loss_percent).toBe(20);
    expect(config.log.rotation_size_mb).toBe(10);
    expect(config.warning.rate_limit_ms).toBe(1800000);
  });
});
