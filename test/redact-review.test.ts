import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import providerSecrets from './fixtures/secrets/provider-secrets.json';
import { redact, type RedactOptions } from '../src/core/redact.js';
import { formatUserError, peekWarnings } from '../src/core/errors.js';
import { mehmoryHome } from '../src/core/home.js';
import { distill } from '../src/distill/distill.js';

const inlineAssignments = [
  ['PGPASSWORD=hunter2 psql -h db', '[REDACTED] psql -h db'],
  ['MYSQL_PWD=x mysql', '[REDACTED] mysql'],
  ['GITHUB_TOKEN=abc gh pr list', '[REDACTED] gh pr list'],
  ['STRIPE_SECRET_KEY=sk_live_x node app.js', '[REDACTED] node app.js'],
  ['OPENAI_API_KEY=sk-short-fake python x.py', '[REDACTED] python x.py'],
  ['docker run -e POSTGRES_PASSWORD=hunter2 postgres', 'docker run -e [REDACTED] postgres'],
  ['env CUSTOM_CREDENTIAL=fake-credential command', 'env [REDACTED] command'],
  ['password=hunter2 psql', '[REDACTED] psql'],
  ['api_key=ZmFrZS1zZWNyZXQ= command', '[REDACTED] command'],
  ['password: hunter2 command', '[REDACTED] command'],
  ['password: hunter2\tnext', '[REDACTED]\tnext'],
  ['login(password:hunter2 next)', 'login([REDACTED] next)'],
];

const delimitedAssignments = [
  ['login(password=hunter2)', 'login([REDACTED])'],
  ['?user=bob&password=hunter2&next=yes', '?user=bob&[REDACTED]&next=yes'],
  ['password=hunter2"', '[REDACTED]"'],
  ["password=hunter2'", "[REDACTED]'"],
  ['password=hunter2>out', '[REDACTED]>out'],
  ['password=hunter2\tnext', '[REDACTED]\tnext'],
];

const negatives = [
  'api_key: str',
  'password: int',
  'secret: true',
  'secret: false',
  'Max token: 4096',
  'AsiaPacificRegionConfig',
  'AkiaPacificRegionConfig',
  'prefixAKIAFAKEFAKEFAKEFAKEsuffix',
  'xoxb-is-the-bot-token-prefix',
  ...[
    'float',
    'bool',
    'bytes',
    'string',
    'number',
    'boolean',
    'bigint',
    'symbol',
    'object',
    'undefined',
    'null',
    'unknown',
    'never',
    'void',
    'any',
  ].map((type) => `secret: ${type}`),
  'TOKEN_EXAMPLE=fake-example',
];

describe('secret filter review regressions', () => {
  it.each(inlineAssignments)('redacts inline env assignment: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each([
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'PGP PRIVATE KEY BLOCK',
    'ENCRYPTED PRIVATE KEY',
  ])('redacts an orphan %s header through the end of input', (label) => {
    expect(redact(`before\n-----BEGIN ${label}-----\n${'ZmFrZQ=='.repeat(60)}`)).toBe(
      'before\n[REDACTED]'
    );
  });

  it('redacts a private key whose footer label differs', () => {
    expect(
      redact(
        'before\n-----BEGIN RSA PRIVATE KEY-----\nfake-material\n-----END PRIVATE KEY-----\nafter'
      )
    ).toBe('before\n[REDACTED]\nafter');
  });

  it('redacts a key truncated by distillation before its footer', () => {
    const content = `-----BEGIN RSA PRIVATE KEY-----\n${'ZmFrZQ=='.repeat(100)}\n-----END RSA PRIVATE KEY-----`;
    expect(
      distill(
        [{ type: 'user', uuid: 'truncated-key', message: { role: 'user', content } }],
        'fake-session'
      )[0]?.content
    ).toBe('[REDACTED]');
  });

  it.each(['redis', 'rediss'])('redacts %s credentials with an empty username', (scheme) => {
    expect(redact(`${scheme}://:fake-password@host.invalid/db`)).toBe('[REDACTED]host.invalid/db');
  });

  it.each(providerSecrets)('redacts the complete %s fixture', (_name, text) => {
    expect(redact(`before ${text} after`)).toBe('before [REDACTED] after');
    expect(redact(`before ${text} after`, { patterns: ['/CUSTOM-FAKE/g'] })).toBe(
      'before [REDACTED] after'
    );
  });

  it('redacts a complete base64 bearer token including slash, plus and padding', () => {
    expect(redact('Authorization: Bearer ZmFrZS1iZWFyZXIvdG9rZW4/+==')).toBe(
      'Authorization: [REDACTED]'
    );
  });

  it.each(negatives)(
    'preserves lowercase keywords, numbers and non-secret identifiers: %s',
    (text) => {
      expect(redact(text)).toBe(text);
    }
  );

  it.each(delimitedAssignments)(
    'redacts an unquoted delimited assignment: %s',
    (text, expected) => {
      expect(redact(text)).toBe(expected);
    }
  );

  it('redacts escaped key and value quotes in stringified JSON', () => {
    expect(redact(String.raw`"{\"api_key\":\"secret-value-1234\"}"`)).toBe('"{[REDACTED]}"');
  });

  it('logs fail-closed errors without logging the input or exception message', () => {
    const options: RedactOptions = {
      get patterns(): readonly string[] {
        throw new Error('fake-sensitive-exception');
      },
    };
    expect(redact('fake-sensitive-input', options)).toBe('[REDACTED]');
    const log = readFileSync(join(mehmoryHome(), '.state/errors.log'), 'utf8');
    expect(log).toContain('E_REDACT_FAILED');
    expect(log).not.toContain('fake-sensitive');
    expect(peekWarnings()).toContainEqual(expect.stringContaining('E_REDACT_FAILED'));
    expect(
      formatUserError({
        code: 'E_REDACT_FAILED',
        kind: 'informational',
        what: 'Secret filtering failed',
        consequence: 'The entire text was redacted',
      })
    ).toContain('The entire text was redacted.');
  });

  it('indexes the invalid-settings consequence in troubleshooting', () => {
    expect(readFileSync(join(process.cwd(), 'docs/TROUBLESHOOTING.md'), 'utf8')).toContain(
      'Only invalid settings use defaults; valid settings are still applied.'
    );
  });

  it.each([
    ['scheme-like text', 'a.'.repeat(100_000), undefined],
    ['repeated incomplete URLs', 'a://u:'.repeat(34_000) + '[', undefined],
    ['repeated token assignments', 'token='.repeat(34_000) + '[', '[REDACTED]'],
    ['repeated password assignments', 'password:'.repeat(23_000) + '[', undefined],
  ])('finishes 200 KB of %s in less than 200 ms', (_name, text, expected) => {
    const start = performance.now();
    const result = redact(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(result).toBe(expected ?? text);
  });

  it('fails closed above the 256 KiB input cap in less than 200 ms', () => {
    const text = 'a.'.repeat(200_000);
    const start = performance.now();
    expect(redact(text)).toBe('[REDACTED]');
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('measures the input cap in UTF-8 bytes, not characters', () => {
    expect(redact('é'.repeat(128 * 1024 + 1))).toBe('[REDACTED]');
    const withinLimit = 'é'.repeat(128 * 1024);
    expect(redact(withinLimit)).toBe(withinLimit);
  });

  it('applies the input cap before reading options or honoring whitelist', () => {
    const text = 'a'.repeat(256 * 1024 + 1);
    let optionsRead = false;
    expect(
      redact(text, {
        get patterns(): readonly string[] {
          optionsRead = true;
          return [];
        },
        whitelist: [text],
      })
    ).toBe('[REDACTED]');
    expect(optionsRead).toBe(false);
  });
});
