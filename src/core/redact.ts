/**
 * Secret filter: regex-based pattern detection for API keys, tokens, credentials.
 *
 * LIMITATION (A3): This is best-effort pattern matching. It catches common forms
 * (AWS keys, GitHub tokens, bearer tokens, private-key blocks, .env-shaped secrets,
 * URL-embedded credentials) but does NOT reliably catch PII or prose secrets.
 * A regex-based filter has a known ceiling: entropy scoring or a real scanner is needed
 * for higher confidence.
 *
 * Never throws on any input (including empty string, very large strings, invalid UTF-16).
 * Returns the input text with matched secrets redacted as [REDACTED].
 */

// ponytail: Regexes are patterns, not comprehensive scanners. Upgrade path:
// entropy scoring (strings with high entropy) or integrating a real scanner (trivy, talisman).

const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Pattern list with their coverage.
 * Keep in sync with test fixture corpus under test/fixtures/secrets/.
 */
const SECRET_PATTERNS = [
  // AWS: AKIA... access keys (20 chars after AKIA)
  /AKIA[0-9A-Z]{16}/gi,

  // AWS: secret access keys (40 chars, base64-like)
  /aws_secret_access_key\s*=\s*([A-Za-z0-9/+=]{40})/gi,

  // GitHub: ghp_ personal access tokens (36 chars after ghp_)
  /ghp_[A-Za-z0-9_]{36}/gi,

  // GitHub: ghs_ OAuth tokens (37 chars after ghs_)
  /ghs_[A-Za-z0-9_]{37}/gi,

  // GitHub: ghu_ user tokens (37 chars after ghu_)
  /ghu_[A-Za-z0-9_]{37}/gi,

  // Generic bearer token: Bearer <token> (assumes token is 32+ chars of non-space)
  /bearer\s+[A-Za-z0-9._-]{32,}/gi,

  // Private key blocks: -----BEGIN...-----END
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,

  // .env-style KEY=value (requires KEY to be UPPERCASE_WORD and value to be non-empty, non-quoted)
  // Excludes lines like PATH=/usr/bin, common env vars
  /^([A-Z][A-Z0-9_]*(?<!PATH|HOME|USER|SHELL|LANG|TERM))\s*=\s*([^\s'"]+)$/gm,

  // URL-embedded credentials: scheme://user:pass@host
  // eslint-disable-next-line no-useless-escape
  /(?:https?|ftp|ssh):\/\/[A-Za-z0-9._%-]+:[A-Za-z0-9!@#$%^&*()_+=\[\]{}|;':",./<>?-]{1,}@/gi,

  // API keys (APIKEY=... or api_key=..., common pattern)
  /(api[_-]?key|apikey)\s*=\s*([A-Za-z0-9_-]{20,})/gi,

  // Tokens in common formats: token=..., access_token=...
  /(access[_-]?token|token|auth[_-]?token)\s*=\s*([A-Za-z0-9_-]{20,})/gi,
] as const;

/**
 * Redact secrets from text using the documented pattern corpus.
 * Never throws; returns original text on any error.
 *
 * @param text — The text to redact (empty string, very large, or invalid UTF-16 all handled safely)
 * @returns The text with matched secrets replaced by [REDACTED]
 */
export function redact(text: string): string {
  if (!text || typeof text !== 'string') {
    // text is typed `string`, but this function is a defensive fail-open boundary
    // that must survive untyped/JS callers passing null or undefined at runtime;
    // `?? ''` guards that case even though the TS signature says it can't happen.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return text ?? '';
  }

  try {
    let result = text;

    // Apply each pattern, replacing all matches with REDACTION_PLACEHOLDER
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, REDACTION_PLACEHOLDER);
    }

    return result;
  } catch {
    // On any regex error or unexpected failure, return original text unchanged
    // Better to leak a secret than crash the system
    return text;
  }
}
