import {
  appendFileSync,
  readFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { statePath } from './home.js';

/** Quote a value for a POSIX shell command shown in an actionable fix. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ponytail: errors.ts does its own bounded appends because it is the one module
// that must work before/below the fs layer. fs.ts provides generic writes;
// errors.ts needs only a specific append pattern and cannot depend on fs.ts.
// This is allowed per A3's allowlist.

// The error registry. Run 1 declared it closed for that run; run 3 reopens it for the
// surfaces the CLI adds (plan criterion 14). `kind` here is the code's default class —
// the `fix` string itself is supplied per construction site, and U10 requires it to be
// a runnable command, never prose.
const ERROR_KINDS = {
  E_CONFIG_PARSE: 'actionable',
  E_LOCK_TIMEOUT: 'informational',
  E_DISTILL_LOSSY: 'informational',
  E_STORE_INIT: 'actionable',
  E_GIT_COMMIT: 'informational',
  E_QUEUE_CLAIM: 'informational',
  E_CURSOR_RESET: 'informational',
  E_SESSION_STATE: 'informational',
  E_TRANSCRIPT_PARSE: 'informational',
  E_APPEND_FAILED: 'actionable',
  E_ATOMIC_WRITE: 'actionable',
  // ─── Run 3 (CLI) ───
  /** A `mehmory search` scan failed or was cut short. Nothing for the user to run. */
  E_SEARCH_FAILED: 'informational',
  /** A transcript file could not be read during `onboard`. That session is skipped. */
  E_TRANSCRIPT_READ: 'informational',
  /** A `~/.claude/projects/<encoded>` directory decodes to a path that is gone, so its
   * project key cannot be resolved. Listed as unresolvable and skipped, never guessed. */
  E_TRANSCRIPT_DIR_UNRESOLVED: 'informational',
  /** `mehmory purge` deleted files but could not commit — the store is left dirty, and
   * the remedy is a real command (`git -C <home> commit -a`). */
  E_PURGE_FAILED: 'actionable',
  /** An unexpected CLI exception stopped the command; this is a bug, not an append failure. */
  E_INTERNAL: 'informational',
  // ─── Run 4 (Codex host) ───
  /** `mehmory init --host codex` could not read or write a file under `$CODEX_HOME`.
   * Nothing was modified — the file is shared with other tools, so a config mehmory
   * cannot parse is refused rather than overwritten. */
  E_CODEX_INSTALL: 'actionable',
  /** mehmory is wired into a Codex that is not there: `$CODEX_HOME` holds mehmory's hook
   * entries but no `config.toml`, so those entries are pointing at nothing. */
  E_CODEX_HARNESS_MISSING: 'actionable',
  /** Codex's `[features] hooks` flag is off or unset, so no hook of any tool fires. */
  E_CODEX_HOOKS_DISABLED: 'actionable',
  /** `$CODEX_HOME/hooks.json` carries no mehmory entry for one or more events, so those
   * lifecycle events capture and inject nothing under Codex. */
  E_CODEX_HOOKS_UNWIRED: 'actionable',
  /** Codex has registered mehmory's hooks but has no trust decision for them, so it
   * skips every one silently: capture never fires and no surface says why (issue #39). */
  E_CODEX_HOOKS_UNTRUSTED: 'actionable',
  /** The mehmory skills are not installed for Codex, so the judgment-work commands
   * (integrate, lint, onboard) are unavailable there. Capture still runs. */
  E_CODEX_SKILLS_MISSING: 'actionable',
  // ─── Run 5 (agent scopes) ───
  /** A declared agent name is not usable as a directory segment, so the agent runs
   * unnamed and gets no agent scope. Its own code rather than `E_CONFIG_PARSE`: the
   * name usually comes from the environment rather than config, and the hourly warning
   * rate limit is per code — sharing a bucket would let an unrelated config warning
   * suppress the one that tells an operator which agent is misconfigured. */
  E_AGENT_NAME_INVALID: 'actionable',
} as const satisfies Record<string, 'actionable' | 'informational'>;

export type ErrorCode = keyof typeof ERROR_KINDS;

export type MehmoryError = {
  readonly code: ErrorCode;
  readonly what: string;
  readonly consequence: string;
} & (
  | { readonly kind: 'actionable'; readonly fix: string }
  | { readonly kind: 'informational' }
);

/** Format a MehmoryError into the user-facing template (U1). */
export function formatUserError(error: MehmoryError): string {
  const { code, what, consequence } = error;
  const errorsLogPath = statePath('errors.log');

  let result = `MEHMORY ${code}: ${what}. ${consequence}.`;

  if (error.kind === 'actionable') {
    result += ` Fix: ${error.fix}.`;
  }

  result += ` Details: ${errorsLogPath}`;

  return result;
}

/** Module-level tracking of log file size to avoid statting after every append.
 * Includes the mtime so we can detect if the file was modified outside our tracking. */
let logFileSizeState: { size: number; mtime: number } | null = null;

/** True while the process is a CLI invocation rather than a hook. */
let cliMode = false;

/**
 * Mark this process as a CLI invocation. `src/cli/index.ts` calls this at startup.
 *
 * Effect: `logError` still writes to `errors.log`, but stops calling `recordWarning`,
 * so a failed `mehmory search` does not queue a warning line into the user's *next*
 * Claude Code session — the CLI already reported the failure on its own stdout/stderr.
 *
 * A module flag, not a threaded parameter: `logError` has 17 call sites across 10
 * files in `src/core/`, and A17 forbids `src/core/**` from importing `src/cli/**`.
 */
export function setCliMode(enabled: boolean): void {
  cliMode = enabled;
}

/** Log an error to <home>/.state/errors.log with 5 MB rotation (1 generation kept). */
export function logError(error: MehmoryError): void {
  const logPath = statePath('errors.log');
  const logDir = dirname(logPath);

  // Ensure .state directory exists.
  //
  // Guarded because this is the one place a *reporting* failure could become the
  // caller's failure: when the store path is unusable (a file where the directory
  // should be, a read-only volume), `mkdirSync` throws ENOTDIR/EACCES straight out of
  // `logError` and past every fail-open boundary — observed as an unhandled ENOTDIR
  // stack from `mehmory init`. A2/A11 make logging best-effort, not load-bearing.
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  } catch {
    return; // nowhere to write; the caller still gets its typed error back
  }

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${error.code}: ${error.what}\n`;
  const maxSize = 5 * 1024 * 1024;

  // Initialize or refresh size state. Check mtime to detect if file was modified
  // outside our tracking (e.g., in tests). If mtime changed, restat.
  if (logFileSizeState === null) {
    try {
      const stat = statSync(logPath);
      logFileSizeState = { size: stat.size, mtime: stat.mtime.getTime() };
    } catch {
      // File doesn't exist yet, size is 0
      logFileSizeState = { size: 0, mtime: 0 };
    }
  } else {
    // Check if file was modified externally by comparing mtime
    try {
      const stat = statSync(logPath);
      const currentMtime = stat.mtime.getTime();
      if (currentMtime !== logFileSizeState.mtime) {
        // File mtime changed, invalidate cache and restat
        logFileSizeState = { size: stat.size, mtime: currentMtime };
      }
    } catch {
      // Can't stat, but that's ok—we'll try to append and see what happens
    }
  }

  // Append the line. Guarded for the same reason as the mkdir above: an unwritable
  // errors.log must not turn into the caller's exception.
  try {
    appendFileSync(logPath, line, 'utf-8');
  } catch {
    return;
  }

  // Update tracked size by bytes written (encoded as UTF-8)
  const bytesWritten = Buffer.byteLength(line, 'utf-8');
  logFileSizeState.size += bytesWritten;

  // Rotate if over 5 MB
  if (logFileSizeState.size > maxSize) {
    try {
      const rotatedPath = statePath('errors.log.1');
      // Windows renameSync throws when the target exists; without this the second
      // rotation would fail silently and errors.log would grow unbounded.
      if (existsSync(rotatedPath)) unlinkSync(rotatedPath);
      renameSync(logPath, rotatedPath);
      // After rotation, size resets to 0 and update mtime to reflect the new empty file
      logFileSizeState = { size: 0, mtime: 0 };
    } catch {
      // Rotate failed, ignore (don't create a loop)
    }
  }

  // Record warning for rate-limited injection (U2). Skipped in CLI mode: the CLI
  // reports its own failures, and a warning recorded here would surface in the user's
  // next session instead.
  if (!cliMode) recordWarning(error.code);
}

/**
 * Safely call a function, returning fallback on any error and recording the error.
 *
 * The synthesized error is always `informational`, regardless of the code's registered
 * kind: `failOpen` catches an arbitrary exception and has no idea what the user should
 * run. Its previous `fix: 'See errors.log for details'` restated the `Details:` clause
 * `formatUserError` already appends, which U10 forbids. A caller that *does* know the
 * remedy builds the `actionable` error itself and calls `logError` directly.
 */
export function failOpen<T>(
  fn: () => T,
  fallback: T,
  code: ErrorCode
): T {
  try {
    return fn();
  } catch (err) {
    logError({
      code,
      kind: 'informational',
      what: err instanceof Error ? err.message : String(err),
      consequence: 'Operation failed; using fallback',
    });
    return fallback;
  }
}

/** Rate-limited warning state: keyed by error code, 1 per hour by default (A8). */
interface WarningRecord {
  code: string;
  lastTime: number;
  count: number;
}

/** Validate a parsed warning entry. The file is user-writable and survives
 * across processes, so a hand-edited or half-written entry must be dropped rather
 * than trusted — this is a fail-open path and must not throw. */
function isWarningRecord(value: unknown): value is WarningRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['code'] === 'string' &&
    typeof v['lastTime'] === 'number' &&
    typeof v['count'] === 'number'
  );
}

const WARN_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour
const WARNING_CLAIM_STALE_MS = 60 * 1000;

/** Published records are immutable; include the pre-upgrade array until drained. */
function warningPaths(): string[] {
  const paths: string[] = [];
  const legacy = statePath('warnings.json');
  if (existsSync(legacy)) paths.push(legacy);
  const dir = statePath('warning-records');
  try {
    paths.push(
      ...readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(dir, name))
    );
  } catch {
    // Missing or unreadable warning directory.
  }
  // A crashed drain may have renamed a record without reading it. Reclaim only
  // after a minute so a concurrent active drain keeps exclusive ownership.
  for (const claimDir of [statePath(), dir]) {
    try {
      for (const name of readdirSync(claimDir)) {
        if (!/\.json(?:\.drain-[0-9a-f-]{36})+$/.test(name)) continue;
        if (claimDir !== dir && !name.startsWith('warnings.json.drain-')) continue;
        const path = join(claimDir, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > WARNING_CLAIM_STALE_MS) paths.push(path);
        } catch {
          // Another drain may have just consumed it.
        }
      }
    } catch {
      // Missing or unreadable state directory.
    }
  }
  return paths;
}

function readWarnings(consume = false): WarningRecord[] {
  const records: WarningRecord[] = [];
  for (const path of warningPaths()) {
    const claimed = consume
      ? `${path.replace(/(?:\.drain-[0-9a-f-]{36})+$/, '')}.drain-${randomUUID()}`
      : path;
    let renamed = false;
    if (consume) {
      try {
        renameSync(path, claimed);
        renamed = true;
        // Rename preserves mtime; an old warning must not look like a stale active claim.
        const now = new Date();
        utimesSync(claimed, now, now);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Read-only state still has useful warnings, even though they cannot be claimed.
      }
    }
    const readPath = renamed ? claimed : path;
    try {
      const contents = readFileSync(readPath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents) as unknown;
      } catch {
        if (renamed) {
          try {
            unlinkSync(claimed);
          } catch {
            // Do not republish corrupt JSON, even if cleanup is temporarily impossible.
          }
        }
        continue;
      }
      records.push(
        ...(Array.isArray(parsed)
          ? parsed.filter(isWarningRecord)
          : isWarningRecord(parsed)
            ? [parsed]
            : [])
      );
      if (renamed) unlinkSync(claimed);
    } catch {
      if (renamed) {
        try {
          renameSync(claimed, path);
        } catch {
          // Best-effort restoration only for I/O failures, not corrupt JSON.
        }
      }
    }
  }

  // Concurrent producers of the same code may both pass the rate-limit check.
  // Coalesce them without discarding a different code or a later hourly occurrence.
  const warnings = new Map<string, WarningRecord>();
  for (const record of records.sort((a, b) => a.lastTime - b.lastTime)) {
    const existing = warnings.get(record.code);
    if (!existing) warnings.set(record.code, { ...record });
    else if (record.lastTime - existing.lastTime >= WARN_RATE_LIMIT_MS) {
      existing.lastTime = record.lastTime;
      existing.count += record.count;
    }
  }
  return [...warnings.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Record a warning (rate-limited to 1 per hour per code). Marks as delivered when read. */
export function recordWarning(code: ErrorCode): void {
  const dir = statePath('warning-records');
  const path = join(dir, `${randomUUID()}.json`);
  const temp = `${path}.tmp`;
  try {
    const now = Date.now();
    const existing = readWarnings().find((w) => w.code === code);
    if (existing && now - existing.lastTime < WARN_RATE_LIMIT_MS) return;
    mkdirSync(dir, { recursive: true });
    // Publish only after the full record is written. A drain cannot see a partial
    // record, and no writer retains an open descriptor to a file being consumed.
    writeFileSync(temp, JSON.stringify({ code, lastTime: now, count: 1 }), { flag: 'wx' });
    renameSync(temp, path);
  } catch {
    // Warning storage must never turn a reporting failure into a caller failure.
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file is normally already renamed or was never created.
    }
  }
}

function warningLines(warnings: WarningRecord[]): readonly string[] {
  return warnings.map((w) => {
    const kind =
      (ERROR_KINDS as Record<string, 'actionable' | 'informational'>)[w.code] ?? 'informational';
    return `${w.code} (${kind}, ${String(w.count)} occurrences): see ${statePath('errors.log')}`;
  });
}

/**
 * Pending warnings **without** consuming them.
 *
 * `pendingWarnings()` is SessionStart's only warning channel and clears as it reads, so
 * a read-only consumer (`mehmory status`, `mehmory doctor`) must use this instead — a
 * CLI invocation that stole the warning would mean the user's next session never sees it.
 */
export function peekWarnings(): readonly string[] {
  return warningLines(readWarnings());
}

/** Get pending warnings as formatted strings for injection. Returns and clears. */
export function pendingWarnings(): readonly string[] {
  return warningLines(readWarnings(true));
}
