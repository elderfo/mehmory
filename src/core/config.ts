import { join } from 'node:path';
import { mehmoryHome } from './home.js';
import { logError, type MehmoryError } from './errors.js';
import { readFile, pathExists } from './fs.js';

/** Per-hook switch. An object rather than a bare boolean so run 3 can add per-hook
 * bounds (timeouts, budgets) without another config shape change. */
export interface HookToggle {
  readonly enabled: boolean;
}

/** Full configuration schema for mehmory. All keys are required (no partial config). */
export interface MehmoryConfig {
  readonly injection: {
    readonly budget_tokens: number;
  };
  readonly decay: {
    readonly enabled: boolean;
    readonly archive_days: number;
    readonly purge_days: number;
  };
  readonly secrets: {
    /** Extra patterns, each in `RegExp.prototype.toString()` form (`/source/flags`).
     * Additive: the built-in corpus in `redact.ts` always stays in force. */
    readonly patterns: readonly string[];
    /** Literal substrings that are exempt from redaction. */
    readonly whitelist: readonly string[];
  };
  readonly stop: {
    /** Stop invocations since the last capture that trigger a capture + block. */
    readonly capture_threshold: number;
  };
  /** Per-hook enable switches (criterion 19). Snake-case keys match the hook filenames. */
  readonly hooks: {
    readonly session_start: HookToggle;
    readonly user_prompt_submit: HookToggle;
    readonly stop: HookToggle;
    readonly pre_compact: HookToggle;
    readonly session_end: HookToggle;
  };
  readonly inbox: {
    /** Entries in inbox.md at or above which SessionStart nudges to integrate. */
    readonly nudge_entries: number;
    /** inbox.md byte size at or above which SessionStart nudges to integrate. */
    readonly nudge_bytes: number;
  };
  readonly session_state: {
    /** Age at which `.state/<session-id>.json` files are swept. */
    readonly max_age_days: number;
  };
  readonly match: {
    /** Jaccard similarity at or above which the topic cache skips a page lookup. */
    readonly jaccard: number;
    /** Topic cache TTL in ms. */
    readonly cache_ttl_ms: number;
  };
  readonly identity: {
    readonly aliases: Record<string, string>;
  };
  readonly lock: {
    readonly retry_count: number;
    readonly retry_delay_ms: number;
    readonly stale_ms: number;
  };
  readonly queue: {
    readonly max_claims: number;
    readonly stale_ms: number;
    /** Queued jobs claimed per SessionStart (A16 maintenance lane bound). */
    readonly claims_per_start: number;
  };
  readonly distill: {
    readonly max_loss_percent: number;
  };
  readonly log: {
    readonly rotation_size_mb: number;
  };
  readonly warning: {
    readonly rate_limit_ms: number;
  };
}

/**
 * Full set of defaults as specified by the design spec and plan amendments.
 * Every key from the spec must be present here with its specified default value.
 */
const DEFAULTS: MehmoryConfig = {
  injection: {
    budget_tokens: 800,
  },
  decay: {
    enabled: true,
    archive_days: 60,
    purge_days: 90,
  },
  secrets: {
    patterns: [
      // AWS keys: AKIA... or similar
      /AKIA[0-9A-Z]{16}/,
      // GitHub tokens: ghp_ or ghs_ or ghu_ or gho_
      /gh[psuor]_[A-Za-z0-9_]{36,255}/,
      // Generic bearer tokens
      /bearer\s+[A-Za-z0-9._-]{20,}/i,
      // Private key blocks
      /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/,
      // .env-shaped KEY=value
      /^[A-Z_][A-Z0-9_]*=.+$/m,
    ].map(p => p.toString()),
    whitelist: [],
  },
  stop: {
    capture_threshold: 15,
  },
  hooks: {
    session_start: { enabled: true },
    user_prompt_submit: { enabled: true },
    stop: { enabled: true },
    pre_compact: { enabled: true },
    session_end: { enabled: true },
  },
  inbox: {
    nudge_entries: 10,
    nudge_bytes: 8192,
  },
  session_state: {
    max_age_days: 14,
  },
  match: {
    jaccard: 0.7,
    cache_ttl_ms: 300000,
  },
  identity: {
    aliases: {},
  },
  lock: {
    retry_count: 50,
    retry_delay_ms: 100,
    stale_ms: 30000,
  },
  queue: {
    max_claims: 3,
    stale_ms: 30000,
    claims_per_start: 1,
  },
  distill: {
    max_loss_percent: 10,
  },
  log: {
    rotation_size_mb: 5,
  },
  warning: {
    rate_limit_ms: 3600000, // 1 hour
  },
};

/**
 * Load and return the fully-defaulted configuration.
 *
 * Behavior:
 * - If config.json does not exist, returns full defaults
 * - If config.json exists and is valid JSON, deep-merges user config over defaults
 * - If config.json exists but is unparseable, logs E_CONFIG_PARSE and returns defaults
 * - MEHMORY_HOME env var overrides the home directory
 * - Never throws; always returns a valid, fully-populated MehmoryConfig
 */
export function loadConfig(): MehmoryConfig {
  const home = mehmoryHome();
  const configPath = join(home, 'config.json');

  // If config.json doesn't exist, return full defaults
  if (!pathExists(configPath)) {
    return deepClone(DEFAULTS) as MehmoryConfig;
  }

  const createConfigParseError = (what: string): MehmoryError => ({
    code: 'E_CONFIG_PARSE',
    kind: 'actionable',
    what,
    consequence: 'Memory is running on defaults, so your settings are not applied.',
    fix: `$EDITOR ${configPath}`,
  });

  // Try to read and parse config.json
  let userConfig: unknown;
  try {
    const content = readFile(configPath);
    userConfig = JSON.parse(content);
  } catch (err) {
    // Log E_CONFIG_PARSE and return defaults (never throw)
    const message = err instanceof Error ? err.message : String(err);
    logError(createConfigParseError(`config.json is not valid JSON (${message}).`));
    return deepClone(DEFAULTS) as MehmoryConfig;
  }

  // Ensure userConfig is an object
  if (typeof userConfig !== 'object' || userConfig === null) {
    logError(createConfigParseError('config.json root is not an object.'));
    return deepClone(DEFAULTS) as MehmoryConfig;
  }

  // Deep merge user config over defaults
  const merged = deepMerge(
    deepClone(DEFAULTS) as Record<string, unknown>,
    userConfig as Record<string, unknown>
  );

  return merged as unknown as MehmoryConfig;
}

/**
 * Deep merge source into target, recursively.
 * Target is mutated. Handles nested objects; arrays are replaced (not merged).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        key in target &&
        typeof target[key] === 'object' &&
        target[key] !== null &&
        !Array.isArray(target[key])
      ) {
        // Both are objects (not arrays), recurse
        deepMerge(
          target[key] as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        );
      } else {
        // Replace (scalar, array, or source is not an object)
        target[key] = sourceValue;
      }
    }
  }

  return target;
}

/**
 * Deep clone an object recursively.
 */
function deepClone(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item));
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }

  const cloned: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
    }
  }

  return cloned;
}
