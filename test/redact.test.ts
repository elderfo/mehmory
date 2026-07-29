import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../src/core/redact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load fixtures synchronously at module level
const fixturesDir = join(__dirname, 'fixtures', 'secrets');
const hitsAWS = readFileSync(join(fixturesDir, 'aws-keys.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());
const hitsGitHub = readFileSync(join(fixturesDir, 'github-tokens.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());
const hitsBearer = readFileSync(join(fixturesDir, 'bearer-tokens.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());
const hitsPrivateKeys = readFileSync(join(fixturesDir, 'private-keys.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());
const hitsEnvSecrets = readFileSync(join(fixturesDir, 'env-secrets.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());
const hitsURLCredentials = readFileSync(join(fixturesDir, 'url-credentials.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());
const falsePosatives = readFileSync(join(fixturesDir, 'false-positives.txt'), 'utf-8')
  .split('\n')
  .filter(l => l.trim());

describe('redact', () => {
  describe('hits: AWS keys', () => {
    hitsAWS.forEach((line, i) => {
      it(`redacts AWS key fixture ${i + 1}`, () => {
        const result = redact(line);
        expect(result).toContain('[REDACTED]');
        expect(result).not.toContain(line.substring(0, 10)); // at least partial should be gone
      });
    });
  });

  describe('hits: GitHub tokens', () => {
    hitsGitHub.forEach((line, i) => {
      it(`redacts GitHub token fixture ${i + 1}`, () => {
        const result = redact(line);
        expect(result).toContain('[REDACTED]');
      });
    });
  });

  describe('hits: Bearer tokens', () => {
    hitsBearer.forEach((line, i) => {
      it(`redacts bearer token fixture ${i + 1}`, () => {
        const result = redact(line);
        expect(result).toContain('[REDACTED]');
      });
    });
  });

  describe('hits: Private keys', () => {
    // For multi-line private keys, join them
    it('redacts private key blocks', () => {
      const privKeyText = hitsPrivateKeys.join('\n');
      const result = redact(privKeyText);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('hits: .env secrets', () => {
    hitsEnvSecrets.forEach((line, i) => {
      it(`redacts .env secret fixture ${i + 1}`, () => {
        const result = redact(line);
        expect(result).toContain('[REDACTED]');
      });
    });
  });

  describe('hits: URL embedded credentials', () => {
    hitsURLCredentials.forEach((line, i) => {
      it(`redacts URL credential fixture ${i + 1}`, () => {
        const result = redact(line);
        expect(result).toContain('[REDACTED]');
      });
    });
  });

  describe('non-hits: false positives', () => {
    falsePosatives.forEach((line, i) => {
      it(`does NOT redact false positive ${i + 1}`, () => {
        const result = redact(line);
        expect(result).toBe(line);
      });
    });
  });

  describe('safety: never throws', () => {
    it('handles empty string', () => {
      expect(() => redact('')).not.toThrow();
      expect(redact('')).toBe('');
    });

    it('handles very large string', () => {
      const large = 'a'.repeat(10_000_000);
      expect(() => redact(large)).not.toThrow();
    });

    it('handles non-string input gracefully', () => {
      expect(() => redact(null as any)).not.toThrow();
      expect(redact(undefined as any)).toBe('');
    });

    it('handles multiple secrets in one line', () => {
      const line = 'aws key: AKIAIOSFODNN7EXAMPLE and token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12';
      const result = redact(line);
      expect(result).toContain('[REDACTED]');
      expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('completes in bounded time on pathological input (canary)', () => {
      // Canary test: guards against future regex changes that might reintroduce catastrophic
      // backtracking on large unmatched input. Not a regression test for a confirmed bug.
      const pathological = '-----BEGIN PRIVATE KEY-----\n' + '-'.repeat(100_000);
      const startTime = performance.now();
      expect(() => redact(pathological)).not.toThrow();
      const endTime = performance.now();
      const duration = endTime - startTime;
      // Generous time bound (varies with system load); asserts bounded work, not tight deadline
      expect(duration).toBeLessThan(5000);
    });

    it('redacts private keys with false -----END inside body', () => {
      // Regression test: private key whose base64 body contains '-----END' must still match
      // to the actual terminator. Previously untested edge case.
      const keyWithFalseTerminator = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADA-----END
anotherline
-----END PRIVATE KEY-----`;
      const result = redact(keyWithFalseTerminator);
      expect(result).toContain('[REDACTED]');
      // Entire block redacted, not stopped at false terminator
      expect(result).not.toContain('MIIEvQIBADA');
      expect(result).not.toContain('anotherline');
    });
  });
});
