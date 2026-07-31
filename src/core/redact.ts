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

import { join } from 'node:path';
import { logError } from './errors.js';
import { mehmoryHome } from './home.js';

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
 * User-supplied secret filter settings — structurally `config.secrets`, so callers
 * that already hold a `MehmoryConfig` pass `config.secrets` straight through.
 *
 * `redact()` never loads config itself: it runs three times per SessionStart
 * injection on a <1 s budget, and a disk read there is the hot-path re-read the
 * plan's criterion 13 forbids. Config is loaded once per process and threaded down.
 */
export interface RedactOptions {
  /** Extra patterns in `RegExp.prototype.toString()` form (`/source/flags`). Additive
   * to `SECRET_PATTERNS`, which always stays in force. Malformed entries are logged
   * and skipped (A2 fail-open), never thrown. */
  readonly patterns?: readonly string[];
  /** Literal substrings exempt from redaction. */
  readonly whitelist?: readonly string[];
}

/** Compiled user patterns, keyed by the pattern list. Config defaults mirror the
 * built-in corpus, so the common case recompiles the same five regexes on every
 * call without this. Bounded by the number of distinct pattern lists a process sees
 * (one, in practice). */
const userPatternCache = new Map<string, RegExp[]>();

/** Compile `/source/flags` strings to regexes, skipping (and logging) malformed ones. */
function compileUserPatterns(patterns: readonly string[]): RegExp[] {
  const cacheKey = JSON.stringify(patterns);
  const cached = userPatternCache.get(cacheKey);
  if (cached) return cached;

  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    const parsed = /^\/(.*)\/([a-z]*)$/s.exec(raw);
    try {
      if (!parsed?.[1]) throw new Error('not in /source/flags form');
      const flags = parsed[2] ?? '';
      compiled.push(new RegExp(parsed[1], flags.includes('g') ? flags : flags + 'g'));
    } catch (err) {
      logError({
        code: 'E_CONFIG_PARSE',
        kind: 'actionable',
        what: `secrets.patterns entry ${JSON.stringify(raw)} is not a usable regex (${
          err instanceof Error ? err.message : String(err)
        })`,
        consequence: 'That pattern is skipped; the built-in secret patterns still apply',
        fix: `$EDITOR ${join(mehmoryHome(), 'config.json')}`,
      });
    }
  }

  userPatternCache.set(cacheKey, compiled);
  return compiled;
}

/** Escape a literal for use inside a RegExp. */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyPatterns(text: string, extra: readonly RegExp[]): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTION_PLACEHOLDER);
  }
  for (const pattern of extra) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return result;
}

/**
 * Redact secrets from text using the built-in corpus plus any configured patterns.
 * Never throws; returns original text on any error.
 *
 * @param text — The text to redact (empty string, very large, or invalid UTF-16 all handled safely)
 * @param options — `config.secrets`; omitted means built-in patterns only
 * @returns The text with matched secrets replaced by [REDACTED]
 */
export function redact(text: string, options: RedactOptions = {}): string {
  if (!text || typeof text !== 'string') {
    // text is typed `string`, but this function is a defensive fail-open boundary
    // that must survive untyped/JS callers passing null or undefined at runtime;
    // `?? ''` guards that case even though the TS signature says it can't happen.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return text ?? '';
  }

  try {
    const extra = options.patterns ? compileUserPatterns(options.patterns) : [];
    const whitelist = (options.whitelist ?? []).filter(entry => entry !== '');
    if (whitelist.length === 0) return applyPatterns(text, extra);

    // ponytail: whitelisted literals are cut out and the gaps redacted separately,
    // so a whitelisted string can never be matched. Ceiling: a multi-line pattern
    // spanning a whitelisted literal no longer matches. Upgrade path is
    // match-then-restore if that ever bites.
    const splitter = new RegExp(`(${whitelist.map(escapeLiteral).join('|')})`);
    return text
      .split(splitter)
      .map((segment, i) => (i % 2 === 1 ? segment : applyPatterns(segment, extra)))
      .join('');
  } catch {
    // On any regex error or unexpected failure, return original text unchanged
    // Better to leak a secret than crash the system
    return text;
  }
}
