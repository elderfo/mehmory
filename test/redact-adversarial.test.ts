import { describe, expect, it } from 'vitest';
import { redact, SECRET_PATTERNS } from '../src/core/redact.js';

const INPUT_CHARS = 250 * 1024;
const SEPARATORS = ['-', '.', '_', '/', ':', '=', ' '];

function repeatToSize(prefix: string, head = ''): string {
  return (
    head +
    prefix
      .repeat(Math.ceil((INPUT_CHARS - head.length) / prefix.length))
      .slice(0, INPUT_CHARS - head.length)
  );
}

const structuralInputs = [
  ['flattened PEM', repeatToSize('MIIEAAAA', '-----BEGIN RSA PRIVATE KEY----- ')],
  ['adjacent PEM body', repeatToSize('MIIEAAAA', '-----BEGIN RSA PRIVATE KEY-----')],
  ['escaped CRLF PEM', repeatToSize('MIIEAAAA', String.raw`-----BEGIN RSA PRIVATE KEY-----\r\n`)],
  ['PEM header padding without body', repeatToSize(' \t', '-----BEGIN RSA PRIVATE KEY-----')],
  ['PEM label words without terminator', repeatToSize('RSA \t', '-----BEGIN\t')],
  ['PEM body with repeated headers', repeatToSize('-----BEGIN\tRSA  PRIVATE\tKEY-----\n')],
  ['camelCase name without assignment', repeatToSize('a', 'client')],
  ['camelCase quoted value without terminator', repeatToSize('a', 'clientSecret="')],
  ['camelCase equals value', repeatToSize('A', 'clientSecret=')],
  ['camelCase colon value', repeatToSize('A', '{clientSecret:')],
  ['bare capitalized value', repeatToSize('A', 'password=')],
  ['bare capitalized colon value', repeatToSize('A', '{password:')],
  ['escaped env quote without terminator', repeatToSize('a', String.raw`PGPASSWORD=\"`)],
  ['ANSI-C env quote without terminator', repeatToSize(String.raw`a\'`, "PGPASSWORD=$'")],
  ['template value without terminator', repeatToSize('a\\`', 'apiKey=`')],
  ['passphrase inline value', repeatToSize('a', 'run SSH_PASSPHRASE=')],
  ['bare passphrase inline value', repeatToSize('a', 'run PASSPHRASE=')],
  ['PIN inline value', repeatToSize('a', 'run APP_PIN=')],
  ['URL password with repeated at signs', repeatToSize('p@ss@', 'https://user:')],
  ['URL password with at signs and slashes', repeatToSize('p@ss/', 'https://user:')],
  ['repeated credential URL prefixes', repeatToSize('a://u:p@ss@')],
] as const;

describe('every built-in secret pattern has bounded adversarial work', () => {
  for (const [index, pattern] of SECRET_PATTERNS.entries()) {
    it(`bounds built-in ${String(index)}: ${pattern.source}`, () => {
      // Literal fragments are derived from the corpus, so adding a pattern also adds
      // its prefixes to the canary without requiring a second hand-maintained list.
      const prefixes = new Set(
        pattern.source.replace(/\\[bBsSdDwW]/g, '').match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []
      );
      for (const prefix of prefixes) {
        for (const separator of SEPARATORS) {
          const text = repeatToSize(prefix + separator);
          expect(Buffer.byteLength(text, 'utf8')).toBe(INPUT_CHARS);
          const start = performance.now();
          const result = redact(text);
          const elapsed = performance.now() - start;
          expect(elapsed, `${prefix}${separator} against ${pattern.source}`).toBeLessThan(200);
          expect(result.length).toBeGreaterThan(0);
        }
      }
      for (const [name, text] of structuralInputs) {
        expect(Buffer.byteLength(text, 'utf8')).toBe(INPUT_CHARS);
        pattern.lastIndex = 0;
        const start = performance.now();
        const result = text.replace(pattern, '[REDACTED]');
        expect(performance.now() - start, `${name} against ${pattern.source}`).toBeLessThan(200);
        expect(result.length).toBeGreaterThan(0);
      }
      for (const text of [
        repeatToSize('b/', 'a://u:'),
        repeatToSize('Abc012_-'),
        repeatToSize('word012_'),
      ]) {
        const start = performance.now();
        const result = redact(text);
        expect(performance.now() - start, pattern.source).toBeLessThan(200);
        expect(result).toBe(text);
      }
    }, 60_000);
  }
});

describe('structured adversarial inputs stay below the cap', () => {
  it.each(structuralInputs)('bounds the complete filter for %s', (_name, text) => {
    expect(Buffer.byteLength(text, 'utf8')).toBe(INPUT_CHARS);
    const start = performance.now();
    expect(redact(text).length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
