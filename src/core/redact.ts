/**
 * Secret filter: regex-based pattern detection for API keys, tokens, credentials.
 *
 * LIMITATION (A3): This is best-effort pattern matching. It catches common forms
 * (provider tokens, authorization headers, private-key blocks, secret assignments,
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
const MAX_INPUT_BYTES = 256 * 1024;
const SECRET_NAME = String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|(?!sharedaccesskey\b)[a-z0-9]*(?:token|password|passwd|secret|(?:api|secret|private|access|signing|ssh)key)|[a-z][a-z0-9_]*_(?:key|token|password|passwd|secret))`;
// These Azure names retain their dedicated value-length rule, not generic matching.
const CAMEL_SECRET_NAME = String.raw`(?!(?:AccountKey|SharedAccessKey)\b)[A-Za-z][A-Za-z0-9]*(?:Key|Token|Password|Passwd|Secret)`;
const VALUE_DELIMITER = String.raw`[\s,};#)"'&>]|$`;
const NON_SECRET_VALUE =
  /^(?:true|false|str|int|float|bool|bytes|string|integer|optional|any|number|boolean|bigint|symbol|object|undefined|null|unknown|never|void|[+-]?\d{1,19}(?:\.\d+)?)$/;
const BARE_VALUE = String.raw`[A-Za-z0-9_./+@!$%*?~-]+(?::[A-Za-z0-9_./+@!$%*?~-]+)?=*`;
const QUOTED_VALUE = String.raw`(?:\\"(?:\\(?!")[\s\S]|[^"\\\r\n])+\\"|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|\x60(?:\\[\s\S]|[^\x60\\])+\x60)`;
const ENV_VALUE = String.raw`[^\s"'&>;)\x60]+`;
const ASSIGNMENT_PATTERNS = (
  [
    [SECRET_NAME, 'gim'],
    [CAMEL_SECRET_NAME, 'gm'],
  ] as const
).flatMap(([name, flags]) => [
  // Try structured values first, then the shell stop set for arbitrary '=' values.
  // Bare ':' values in prose still need a structural delimiter, not the next word.
  new RegExp(
    String.raw`(?:\bexport\s+)?(?:\\?["'])?\b${name}\b(?:\\?["'])?\s*(?:[:=]\s*${QUOTED_VALUE}|=\s*${BARE_VALUE}(?=${VALUE_DELIMITER})|=\s*${ENV_VALUE}|:\s*${BARE_VALUE}(?=[ \t]*(?:[,};#)"'&>]|$)))`,
    flags
  ),
  new RegExp(
    String.raw`(?<=^|[{(,;])[ \t]*${name}\b\s*:\s*${BARE_VALUE}(?=${VALUE_DELIMITER})`,
    flags
  ),
]);

/**
 * Pattern list with their coverage.
 * Keep in sync with test fixture corpus under test/fixtures/secrets/.
 * @internal Exposed only for exhaustive regression tests, not a supported API.
 */
export const SECRET_PATTERNS = [
  // AWS access keys, including temporary STS credentials.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /aws_secret_access_key\s*=\s*([A-Za-z0-9/+=]{40})/gi,

  /gh[psuor]_[A-Za-z0-9_]{36,}/gi,
  /github_pat_[A-Za-z0-9_]{22,}/gi,
  /sk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{48}\b/g,
  /\b(?:[sr]k_(?:live|test)_|whsec_)[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
  /\b(?:AccountKey|SharedAccessKey)\s*=\s*[A-Za-z0-9/+]{16,}=*/gi,
  /Authorization\s*:\s*Basic\s+[A-Za-z0-9/+]+=*/gi,
  /xox[abposr]-\d+-[A-Za-z0-9-]{10,}/g,
  /bearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,

  // Distillation may cut off the footer; a public-key footer must not end the match.
  // Unknown body separators need a nearby footer, so prose-only headers stay readable.
  /-----BEGIN\s+(?:[A-Z]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----(?:[ \t]*(?:\r?\n|\\n|\\r\\n|[A-Za-z0-9+/=]{20,})[\s\S]*?(?:-----END\s+(?:[A-Z]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----|$)|[\s\S]{0,8192}?-----END\s+(?:[A-Z]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----)/gi,

  // Non-secret environment settings and example identifiers stay readable.
  /^(?![A-Z_][A-Z0-9_]*_EXAMPLE\s*=)([A-Z_][A-Z0-9_]*(?<!PATH|HOME|USER|SHELL|LANG|TERM))\s*=\s*(?:[^\s'"]+|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')$/gm,
  new RegExp(
    String.raw`(?<![A-Za-z0-9_])(?:export\s+)?(?:SECRET_KEY_BASE|PASSPHRASE|[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|PASSPHRASE|AUTH|CREDENTIALS?|_PIN))=(?:\\"(?:\\(?!")[\s\S]|[^"\\\r\n])*\\"|\\"[^\s"]*|"(?:\\.|[^"\\\r\n])*"|\$?'(?:\\.|[^'\\\r\n])*'|${ENV_VALUE})`,
    'g'
  ),

  // A single slash can be password material; '//' stops scans at the next URL.
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:(?:(?:[^\s/"',]|\/(?!\/))+@|(?:[^\s/"]|\/(?!\/))+@)/gi,

  ...ASSIGNMENT_PATTERNS,
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

/** Compiled user patterns, keyed by the pattern list (one list per process in practice). */
const userPatternCache = new Map<string, RegExp[]>();

/** Compile `/source/flags` strings to regexes, skipping (and logging) malformed ones. */
function compileUserPatterns(patterns: readonly string[]): RegExp[] {
  const boundedPatterns = patterns.slice(0, 64).filter((raw) => raw.length <= 512);
  const cacheKey = JSON.stringify(boundedPatterns);
  const cached = userPatternCache.get(cacheKey);
  if (cached) return cached;

  const compiled: RegExp[] = [];
  for (const raw of boundedPatterns) {
    const parsed = /^\/(.*)\/([a-z]*)$/s.exec(raw);
    try {
      if (!parsed?.[1]) throw new Error('not in /source/flags form');
      if (
        parsed[1].length > 256 ||
        (parsed[1].match(/[+*]|\{\d+(?:,\d*)?}/g)?.length ?? 0) > 3 ||
        /\\[1-9]|\([^()]*[+*{][^)]*\)[+*{]/.test(parsed[1]) ||
        /\([^()]*\|[^()]*\)[+*]/.test(parsed[1]) ||
        /\(\?<?[=!]/.test(parsed[1])
      ) {
        throw new Error('pattern is too complex or too long');
      }
      const flags = parsed[2] ?? '';
      compiled.push(new RegExp(parsed[1], flags.includes('g') ? flags : flags + 'g'));
    } catch (err) {
      logError({
        code: 'E_CONFIG_PARSE',
        kind: 'actionable',
        what: `secrets.patterns entry ${String(patterns.indexOf(raw))} is not a usable regex (${
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

/** Half-open `[start, end)` character range of one whitelisted literal occurrence. */
type Range = readonly [start: number, end: number];

/** Every occurrence of every whitelist literal in `text`. */
function whitelistRanges(text: string, whitelist: readonly string[]): Range[] {
  const ranges: Range[] = [];
  for (const literal of whitelist) {
    let from = text.indexOf(literal);
    while (from !== -1) {
      ranges.push([from, from + literal.length]);
      from = text.indexOf(literal, from + 1);
    }
  }
  return ranges;
}

/**
 * True only when a whitelisted literal **fully contains** this match.
 *
 * Redaction wins on any partial overlap. A whitelist entry that is merely a fragment
 * of a secret — `FODNN7` inside an AWS key, a safe line inside a private-key block —
 * exempts nothing, so no whitelist value can ever reduce what the patterns catch.
 */
function isExempt(start: number, end: number, ranges: readonly Range[]): boolean {
  return ranges.some(([from, to]) => from <= start && end <= to);
}

function isNonSecretAssignment(match: string): boolean {
  const assignment =
    /^(?:export\s+)?(?:\\?["'])?([A-Za-z][A-Za-z0-9_-]*)(?:\\?["'])?\s*[:=]\s*(\S+)$/i.exec(
      match.trim()
    );
  if (!assignment) return false;
  const [, name, value] = assignment;
  if (!name || !value) return false;
  return name === value || NON_SECRET_VALUE.test(value);
}

function applyPatterns(
  text: string,
  extra: readonly RegExp[],
  whitelist: readonly string[]
): string {
  let result = text;

  for (const pattern of [...SECRET_PATTERNS, ...extra]) {
    pattern.lastIndex = 0;

    const isAssignment = ASSIGNMENT_PATTERNS.includes(pattern);
    if (whitelist.length === 0 && !isAssignment) {
      result = result.replace(pattern, REDACTION_PLACEHOLDER);
      continue;
    }

    // Recomputed per pattern: an earlier pattern's replacement shifts later offsets.
    const ranges = whitelistRanges(result, whitelist);
    result = result.replace(pattern, (...args: unknown[]): string => {
      const match = String(args[0]);
      if (isAssignment && isNonSecretAssignment(match)) return match;
      // String.replace passes (match, ...groups, offset, whole); none of these
      // patterns use named groups, so the offset is always second from the end.
      const offset = Number(args[args.length - 2]);
      return isExempt(offset, offset + match.length, ranges) ? match : REDACTION_PLACEHOLDER;
    });
  }

  return result;
}

/**
 * Redact secrets from text using the built-in corpus plus any configured patterns.
 * Never throws; unexpected failures or inputs over 256 KiB redact the entire input.
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
    if (text.length > MAX_INPUT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error('redaction input exceeds limit');
    }
    const candidate = options as unknown as Record<string, unknown>;
    const patterns = Array.isArray(candidate.patterns)
      ? candidate.patterns.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const whitelist = Array.isArray(candidate.whitelist)
      ? candidate.whitelist.filter(
          (entry): entry is string => typeof entry === 'string' && entry !== ''
        )
      : [];
    const extra = compileUserPatterns(patterns);

    // Patterns run first; the whitelist can only spare a match it fully contains.
    // ponytail: whitelist ranges are recomputed per pattern — O(patterns × entries)
    // indexOf scans. Ceiling: large whitelists on large inputs. Upgrade path is one
    // combined alternation regex if that ever shows up in a profile.
    return applyPatterns(text, extra, whitelist);
  } catch {
    // Neither the input nor an exception message is safe to include in this log.
    logError({
      code: 'E_REDACT_FAILED',
      kind: 'informational',
      what: 'Secret filtering failed or input exceeded 256 KiB',
      consequence: 'The entire text was redacted',
    });
    return REDACTION_PLACEHOLDER;
  }
}
