/**
 * Flag parsing. Spec-driven so that an unknown flag is a usage error (criterion 2)
 * rather than a silently ignored token, and so that `--project` can be optional-valued
 * (criterion 12) without every command re-deriving that rule.
 */

/**
 * How a flag takes its value.
 * - `boolean` — presence only (`--dry-run`).
 * - `value` — requires one (`--since <iso>`).
 * - `optional` — takes the next token unless it looks like a flag (`--project [<key>]`).
 */
export type FlagKind = 'boolean' | 'value' | 'optional';

export type FlagSpec = Readonly<Record<string, FlagKind>>;

export type FlagValue = string | boolean;

export type ParseResult =
  | { readonly ok: true; readonly flags: ReadonlyMap<string, FlagValue>; readonly positional: readonly string[] }
  | { readonly ok: false; readonly what: string };

/** `--json` and `--help` are accepted by every command; no spec needs to list them. */
const UNIVERSAL: FlagSpec = { json: 'boolean', help: 'boolean' };

/**
 * Parse `argv` against `spec`.
 *
 * Everything after a bare `--` is positional, so a page slug beginning with `-` is
 * still reachable. Repeating a flag keeps the last occurrence.
 */
export function parseFlags(argv: readonly string[], spec: FlagSpec): ParseResult {
  const kinds: FlagSpec = { ...UNIVERSAL, ...spec };
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const kind = Object.prototype.hasOwnProperty.call(kinds, name) ? kinds[name] : undefined;

    if (kind === undefined) {
      return { ok: false, what: `unknown flag \`${token}\`` };
    }

    if (kind === 'boolean') {
      if (inlineValue !== undefined) {
        return { ok: false, what: `\`--${name}\` takes no value` };
      }
      flags.set(name, true);
      continue;
    }

    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (kind === 'value') {
      if (next === undefined) {
        return { ok: false, what: `\`--${name}\` requires a value` };
      }
      flags.set(name, next);
      i++;
      continue;
    }

    // optional: a following flag means "no value given", which is the bare form.
    if (next === undefined || next.startsWith('-')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }

  return { ok: true, flags, positional };
}

/** The string value of a flag, or undefined when absent or given in its bare form. */
export function flagString(flags: ReadonlyMap<string, FlagValue>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** A flag's value parsed as a positive integer, or `undefined` when absent. */
export function flagInteger(
  flags: ReadonlyMap<string, FlagValue>,
  name: string
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly what: string } {
  const raw = flags.get(name);
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return { ok: false, what: `\`--${name}\` requires a whole number` };
  }
  return { ok: true, value: Number(raw) };
}
