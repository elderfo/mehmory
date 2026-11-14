import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { mehmoryHome } from '../src/core/home.js';
import { redact, type RedactOptions } from '../src/core/redact.js';

function writeConfig(secrets: RedactOptions): void {
  mkdirSync(mehmoryHome(), { recursive: true });
  writeFileSync(join(mehmoryHome(), 'config.json'), JSON.stringify({ secrets }));
}

const tokens = [
  ['Anthropic', 'sk-ant-api03-' + 'fake0'.repeat(20)],
  ['OpenAI project', 'sk-proj-' + 'fake0'.repeat(20)],
  ['GitHub fine-grained', 'github_pat_' + 'fake0'.repeat(16)],
  ['GitHub server', 'ghs_' + 'f'.repeat(36)],
  ['GitHub OAuth', 'gho_' + 'f'.repeat(36)],
  ['AWS temporary', 'ASIA' + 'FAKE'.repeat(4)],
  ...['a', 'b', 'p', 'o', 's', 'r'].map((kind) => [
    `Slack xox${kind}`,
    `xox${kind}-0000000000-0000000000-fakefakefakefakefakefake`,
  ]),
] as const;

const assignments = [
  '"api_key": "obviously-fake-value"',
  "api_key: 'obviously-fake-value'",
  'password=obviously-fake-value',
  'password=obviously.fake:value',
  'api_key=obviously.fake/value',
  'secret: obviously-fake-value',
  'API_KEY="obviously fake value"',
  "PASSWORD='obviously fake value'",
  'CUSTOM_CREDENTIAL="obviously fake value"',
  'export SECRET_TOKEN="obviously fake value"',
  '"access_token": "obviously-fake-value"',
  '"auth_token": "obviously-fake-value"',
];

const negatives = [
  'The secret: use a password manager.',
  'The password is not stored here.',
  'function api_key() { return settings.token_count; }',
  'const secret_count = 5;',
  'interface Config { api_key: string; password: string; }',
  'https://example.invalid/path',
  'PATH="/usr/local/bin"',
  'TOKEN_EXAMPLE="ghp_exampletoken123456"',
];

describe('secret filter regressions', () => {
  for (const [name, token] of tokens) {
    it(`redacts the complete ${name} token with default or custom config`, () => {
      expect(redact(`before ${token} after`, loadConfig().secrets)).toBe('before [REDACTED] after');
      writeConfig({ patterns: ['/CUSTOM-FAKE/g'] });
      expect(redact(`before ${token} after`, loadConfig().secrets)).toBe('before [REDACTED] after');
      expect(redact(`before ${token} after`)).toBe('before [REDACTED] after');
    });
  }

  it.each(['postgres', 'postgresql', 'mysql', 'mongodb', 'mongodb+srv', 'redis', 'amqp'])(
    'redacts %s connection credentials with default config',
    (scheme) => {
      expect(
        redact(`connect ${scheme}://fake-user:fake-password@host.invalid/db`, loadConfig().secrets)
      ).toBe('connect [REDACTED]host.invalid/db');
    }
  );

  it.each([
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'PGP PRIVATE KEY BLOCK',
    'ENCRYPTED PRIVATE KEY',
  ])('redacts the complete %s block with default or custom config', (label) => {
    const text = `before\n-----BEGIN ${label}-----\nobviously-fake-key-material\n-----END ${label}-----\nafter`;
    expect(redact(text, loadConfig().secrets)).toBe('before\n[REDACTED]\nafter');
    writeConfig({ patterns: ['/CUSTOM-FAKE/g'] });
    expect(redact(text, loadConfig().secrets)).toBe('before\n[REDACTED]\nafter');
  });

  it.each(assignments)('redacts the entire secret assignment %s', (text) => {
    expect(redact(text, loadConfig().secrets)).toBe('[REDACTED]');
    writeConfig({ patterns: ['/CUSTOM-FAKE/g'] });
    expect(redact(text, loadConfig().secrets)).toBe('[REDACTED]');
  });

  it.each(['const api_key = process.env.API_KEY;', 'const api_key = import.meta.env.API_KEY;'])(
    'redacts property-expression values without a keyword or self exemption: %s',
    (text) => {
      expect(redact(text)).toBe('const [REDACTED];');
      expect(redact(text, loadConfig().secrets)).toBe('const [REDACTED];');
    }
  );

  it.each(negatives)('leaves ordinary prose and identifiers unchanged: %s', (text) => {
    expect(redact(text)).toBe(text);
    expect(redact(text, loadConfig().secrets)).toBe(text);
  });

  it('defaults extra patterns and whitelist to empty lists', () => {
    expect(loadConfig().secrets).toEqual({ patterns: [], whitelist: [] });
  });

  it('keeps former config-only patterns when adding one user pattern', () => {
    const text = 'ghr_' + 'f'.repeat(36) + ' Bearer ' + 'f'.repeat(20) + ' CUSTOM-FAKE';
    writeConfig({ patterns: ['/CUSTOM-FAKE/g'] });
    expect(redact(text, loadConfig().secrets)).toBe('[REDACTED] [REDACTED] [REDACTED]');
  });

  it('counts brace quantifiers when rejecting complex user patterns', () => {
    expect(
      redact('FAKEFAKEFAKEFAKE', {
        patterns: ['/(?:FAKE){1}(?:FAKE){1,2}(?:FAKE){1,}(?:FAKE){1}/g'],
      })
    ).toBe('FAKEFAKEFAKEFAKE');
    const log = readFileSync(join(mehmoryHome(), '.state/errors.log'), 'utf8');
    expect(log).toContain('E_CONFIG_PARSE');
    expect(log).toContain('pattern is too complex or too long');
  });

  it('still accepts simple brace quantifiers', () => {
    expect(redact('FAKEFAKE', { patterns: ['/(?:FAKE){2}/g'] })).toBe('[REDACTED]');
  });

  it('fails closed without throwing if options access fails', () => {
    const options: RedactOptions = {
      get patterns(): readonly string[] {
        throw new Error('simulated options failure');
      },
    };
    expect(redact('safe text and a fake credential', options)).toBe('[REDACTED]');
    expect(redact('fake credential', null as unknown as RedactOptions)).toBe('[REDACTED]');
  });

  it('preserves full-containment whitelist semantics for new patterns', () => {
    const token = 'sk-proj-' + 'fake0'.repeat(20);
    expect(redact(`before ${token} after`, { whitelist: [token] })).toBe(`before ${token} after`);
    expect(redact(`before ${token} after`, { whitelist: ['fake0'] })).toBe(
      'before [REDACTED] after'
    );
  });
});
