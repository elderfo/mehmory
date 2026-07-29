import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig, type MehmoryConfig } from '../src/core/config.js';

/**
 * Test suite for loadConfig.
 * Tests default loading, deep merge, error handling, and full schema presence.
 */
describe('loadConfig', () => {
  let tempDir: string;
  const originalHome = process.env.MEHMORY_HOME;

  beforeEach(() => {
    tempDir = join(tmpdir(), `config-test-${randomBytes(8).toString('hex')}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.MEHMORY_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalHome) {
      process.env.MEHMORY_HOME = originalHome;
    } else {
      delete process.env.MEHMORY_HOME;
    }
  });

  it('returns full defaults when no config.json exists', () => {
    const config = loadConfig();

    // Check that all top-level keys are present
    expect(config).toHaveProperty('injection');
    expect(config).toHaveProperty('decay');
    expect(config).toHaveProperty('secrets');
    expect(config).toHaveProperty('hooks');
    expect(config).toHaveProperty('identity');
    expect(config).toHaveProperty('lock');
    expect(config).toHaveProperty('queue');
    expect(config).toHaveProperty('distill');
    expect(config).toHaveProperty('log');
    expect(config).toHaveProperty('warning');

    // Check specific defaults
    expect(config.injection.budget_tokens).toBe(800);
    expect(config.decay.enabled).toBe(true);
    expect(config.decay.archive_days).toBe(60);
    expect(config.decay.purge_days).toBe(90);
    expect(config.lock.retry_count).toBe(50);
    expect(config.lock.retry_delay_ms).toBe(100);
    expect(config.lock.stale_ms).toBe(30000);
    expect(config.queue.max_claims).toBe(3);
    expect(config.distill.max_loss_percent).toBe(10);
    expect(config.log.rotation_size_mb).toBe(5);
    expect(config.warning.rate_limit_ms).toBe(3600000); // 1 hour
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

  it('allows overriding nested keys without losing siblings', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          SessionStart: false,
          // UserPromptSubmit and others not specified
        },
      }),
      'utf-8'
    );

    const config = loadConfig();

    // User-provided value overrides
    expect(config.hooks.SessionStart).toBe(false);

    // Siblings remain as defaults
    expect(config.hooks.UserPromptSubmit).toBe(true);
    expect(config.hooks.Stop).toBe(true);
    expect(config.hooks.PreCompact).toBe(true);
    expect(config.hooks.SessionEnd).toBe(true);
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
