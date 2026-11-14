import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redact } from '../src/core/redact.js';
import { buildInjection, type InjectionPart } from '../src/core/injection.js';
import { MAX_INJECTION_BUDGET_TOKENS } from '../src/core/config.js';
import { TOKENS_PER_CHAR } from '../src/core/tokens.js';

const shellAssignments = [
  ['Run `PGPASSWORD=hunter2 psql`', 'Run `[REDACTED] psql`'],
  ['`PGPASSWORD=hunter2`', '`[REDACTED]`'],
  ['$(PGPASSWORD=hunter2 psql)', '$([REDACTED] psql)'],
  ['"PGPASSWORD=hunter2 psql"', '"[REDACTED] psql"'],
  ["'PGPASSWORD=hunter2 psql'", "'[REDACTED] psql'"],
  ['echo ok;PGPASSWORD=hunter2 psql', 'echo ok;[REDACTED] psql'],
  ['echo ok|PGPASSWORD=hunter2 psql', 'echo ok|[REDACTED] psql'],
  ['(PGPASSWORD=hunter2 psql)', '([REDACTED] psql)'],
  ['{"cmd":"PGPASSWORD=hunter2 psql"}', '{"cmd":"[REDACTED] psql"}'],
];

const camelNames = [
  'secretAccessKey',
  'clientSecret',
  'refreshToken',
  'privateKey',
  'secretKey',
  'dbPassword',
  'apiSecret',
  'signingKey',
  'encryptionKey',
];

describe('secret boundary regressions', () => {
  it.each(shellAssignments)('redacts shell-boundary env assignment: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each([
    ['https://user:hun/ter2@host', '[REDACTED]host'],
    ['postgres://app:AbC/dEf+GhI=@db/app', '[REDACTED]db/app'],
  ])('redacts URL password containing slash: %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each(['DB_PASS', 'SMTP_PASS', 'REDIS_AUTH', 'NPM_AUTH', 'SECRET_KEY_BASE'])(
    'redacts env suffix %s',
    (name) => {
      expect(redact(`run ${name}=hunter2 command`)).toBe('run [REDACTED] command');
    }
  );

  it.each(camelNames)('redacts camelCase name %s in JSON and JS', (name) => {
    expect(redact(`{"${name}":"hunter2"}`)).toBe('{[REDACTED]}');
    expect(redact(`const ${name} = "hunter2";`)).toBe('const [REDACTED];');
    expect(redact(`${name}=hunter2`)).toBe('[REDACTED]');
    expect(redact(`not_${name}_field()`)).toBe(`not_${name}_field()`);
  });

  it.each(['hun|ter2', 'hun[ter]2', 'hünter2', 'abc=def'])(
    'redacts complete equals value %s',
    (value) => {
      expect(redact(`password=${value} command`)).toBe('[REDACTED] command');
      expect(redact(`token=${value}`)).toBe('[REDACTED]');
    }
  );

  it('preserves a private-key header mentioned in prose', () => {
    const text =
      'The marker -----BEGIN RSA PRIVATE KEY----- identifies a key. Keep this explanation.';
    expect(redact(text)).toBe(text);
  });

  it('still redacts an orphan header followed by a literal newline escape', () => {
    expect(redact(String.raw`before -----BEGIN RSA PRIVATE KEY-----\nfake-material`)).toBe(
      'before [REDACTED]'
    );
  });

  it.each(['AccountKey', 'SharedAccessKey'])('requires 16 characters for Azure %s', (name) => {
    expect(redact(`Use ${name}=abc in docs`)).toBe(`Use ${name}=abc in docs`);
    expect(redact(`Use ${name}=${'f'.repeat(15)} in docs`)).toBe(
      `Use ${name}=${'f'.repeat(15)} in docs`
    );
    expect(redact(`Use ${name}=${'f'.repeat(16)}== in docs`)).toBe('Use [REDACTED] in docs');
  });

  it.each(['this.password = password', 'this.token = token;'])(
    'preserves obvious non-secret bare assignment: %s',
    (text) => {
      expect(redact(text)).toBe(text);
    }
  );

  it.each(['password: SecretStr2', 'token: Jwt2', 'password="SecretStr"', 'password=Password123'])(
    'redacts capitalized and quoted bare assignments: %s',
    (text) => {
      expect(redact(text)).toBe('[REDACTED]');
    }
  );

  it('redacts JWTs while bounding repeated base64url prefixes', () => {
    expect(redact('before eyJfake.eyJfake.fake after')).toBe('before [REDACTED] after');
    const text = 'eyJ-'.repeat(64_000);
    const start = performance.now();
    expect(redact(text)).toBe(text);
    expect(performance.now() - start).toBeLessThan(200);
  }, 30_000);
});

const MAX_CHARS = MAX_INJECTION_BUDGET_TOKENS / TOKENS_PER_CHAR;

const shares = [
  ['identity', 6400],
  ['project', 6400],
  ['index', 12800],
  ['agent', 6400],
] as const;

describe('injection bounds content before redaction', () => {
  it.each(shares)(
    'retains oversized %s content instead of blanking its section',
    (label, chars) => {
      const parts: InjectionPart[] = shares.map(([partLabel]) => ({
        label: partLabel,
        content: 'x'.repeat(300 * 1024),
      }));
      const start = performance.now();
      const frame = buildInjection(parts, { budgetTokens: MAX_INJECTION_BUDGET_TOKENS });
      expect(performance.now() - start).toBeLessThan(200);
      expect(frame[label]).toBe('x'.repeat(chars));
      expect(frame.totalTokens).toBe(MAX_INJECTION_BUDGET_TOKENS);
    }
  );

  it('bounds UTF-8 bytes even for four-byte Unicode characters', () => {
    const frame = buildInjection([{ label: 'index', content: '😀'.repeat(150 * 1024) }]);
    expect(frame.index).toBe('😀'.repeat(800));
    expect(frame.totalTokens).toBe(400);
  });

  it('cannot expose a token straddling the pre-redaction slice', () => {
    const text = 'x'.repeat(MAX_CHARS * 2 - 5) + ' eyJfake.eyJfake.fake ' + 'x'.repeat(300 * 1024);
    const frame = buildInjection([{ label: 'index', content: text }], {
      budgetTokens: MAX_INJECTION_BUDGET_TOKENS,
    });
    expect(frame.index).toBe('x'.repeat(MAX_CHARS / 2));
    expect(frame.totalTokens).toBe(MAX_INJECTION_BUDGET_TOKENS / 2);
  });

  it('does not pull a sliced token into the frame when earlier redaction shrinks content', () => {
    const text = 'Bearer ' + 'f'.repeat(MAX_CHARS * 2 - 12) + ' ghp_' + 'f'.repeat(36);
    const frame = buildInjection([{ label: 'index', content: text }]);
    expect(frame.index).toBe('[REDACTED] [REDACTED]');
  });

  it('drops an incomplete trailing JWT even when the shortened slice still exceeds the frame', () => {
    const text = 'Bearer ' + 'f'.repeat(MAX_CHARS) + ' eyJ' + 'f'.repeat(MAX_CHARS * 2);
    const frame = buildInjection([{ label: 'index', content: text }], {
      budgetTokens: MAX_INJECTION_BUDGET_TOKENS,
    });
    expect(frame.index).toBe('[REDACTED] [REDACTED]');
  });

  it('redacts complete secrets before applying the final budget cut', () => {
    const text = 'x'.repeat(1500) + ' password=' + 'f'.repeat(MAX_CHARS * 2) + ' command';
    const frame = buildInjection([{ label: 'index', content: text }]);
    expect(frame.index).toBe('x'.repeat(1500) + ' [REDACTED]');
  });
});

const privacy = readFileSync(join(process.cwd(), 'docs/PRIVACY.md'), 'utf8');
const limits =
  privacy.split('It does not reliably catch:')[1]?.split('### Whitelist semantics')[0] ?? '';

describe('documented secret filter limits', () => {
  it.each([
    'Authorization: Token',
    'Authorization: ApiKey',
    'curl -u user:pass',
    'mysql -p',
    'Go `:=`',
    'cookies',
    'hf_',
    'dop_v1_',
    'pypi-',
    'xapp-',
    'short key prefix',
  ])('discloses %s in the unreliable-coverage list', (limitation) => {
    expect(limits).toContain(limitation);
  });
});
