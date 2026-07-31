import {
  appendFileSync,
  readFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { statePath } from './home.js';

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

/** Validate a parsed warnings.json entry. The file is user-writable and survives
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

/** Module-level cache for warnings state. Stores parsed warnings and a hash of
 * the file contents. If the hash changes, the file was modified by another process. */
let warningsCacheState: {
  warnings: WarningRecord[];
  contentHash: string;
} | null = null;

/** Quick hash of file contents to detect modifications from other processes. */
function hashFileContents(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Read warnings from cache if file unchanged, otherwise re-read from disk.
 * This avoids the redundant read-parse on every recordWarning call while
 * staying correct against concurrent modifications from other processes. */
function getWarningsFromDisk(warningsPath: string): WarningRecord[] {
  try {
    const data = readFileSync(warningsPath, 'utf-8');
    const contentHash = hashFileContents(data);

    // If cache exists and hash matches, file hasn't changed—use cached version
    if (warningsCacheState !== null && warningsCacheState.contentHash === contentHash) {
      return warningsCacheState.warnings;
    }

    // File changed or no cache yet—parse and update cache
    const parsed: unknown = JSON.parse(data);
    const warnings = Array.isArray(parsed) ? parsed.filter(isWarningRecord) : [];
    warningsCacheState = { warnings, contentHash };
    return warnings;
  } catch {
    return [];
  }
}

/** Record a warning (rate-limited to 1 per hour per code). Marks as delivered when read. */
export function recordWarning(code: ErrorCode): void {
  const warningsPath = statePath('warnings.json');
  const warningsDir = dirname(warningsPath);

  if (!existsSync(warningsDir)) {
    mkdirSync(warningsDir, { recursive: true });
  }

  let warnings: WarningRecord[] = [];
  if (existsSync(warningsPath)) {
    warnings = getWarningsFromDisk(warningsPath);
  }

  const now = Date.now();
  const existingIndex = warnings.findIndex(w => w.code === code);

  if (existingIndex >= 0) {
    const record = warnings[existingIndex];
    if (!record) {
      // Should not happen, but be safe
      warnings.push({ code, lastTime: now, count: 1 });
    } else if (now - record.lastTime < WARN_RATE_LIMIT_MS) {
      // Rate limit not elapsed, skip
      return;
    } else {
      record.lastTime = now;
      record.count++;
    }
  } else {
    warnings.push({ code, lastTime: now, count: 1 });
  }

  // Write whole file, not append (fixes corruption)
  try {
    const jsonStr = JSON.stringify(warnings, null, 2);
    writeFileSync(warningsPath, jsonStr, 'utf-8');
    // After writing, update cache with new state and content hash
    const contentHash = hashFileContents(jsonStr);
    warningsCacheState = { warnings, contentHash };
  } catch {
    // Silently fail to write warnings
  }
}

/** Render the warnings file to its user-facing lines. Empty on any read/parse failure. */
function readWarningLines(warningsPath: string): readonly string[] {
  if (!existsSync(warningsPath)) return [];

  try {
    const parsed: unknown = JSON.parse(readFileSync(warningsPath, 'utf-8'));
    const warnings: WarningRecord[] = Array.isArray(parsed)
      ? parsed.filter(isWarningRecord)
      : [];

    return warnings.map(w => {
      // w.code comes off disk as a bare string (see isWarningRecord) and is not
      // guaranteed to be a known ErrorCode; look it up as a partial map so an
      // unrecognized code still falls back to 'informational' instead of throwing
      // away that fallback (an `as ErrorCode` cast would tell TS it can never miss,
      // which isn't true and would silently drop this behavior).
      const kind =
        (ERROR_KINDS as Record<string, 'actionable' | 'informational'>)[w.code] ??
        'informational';
      return `${w.code} (${kind}, ${String(w.count)} occurrences): see ~/.mehmory/.state/errors.log`;
    });
  } catch {
    return [];
  }
}

/**
 * Pending warnings **without** consuming them.
 *
 * `pendingWarnings()` is SessionStart's only warning channel and clears as it reads, so
 * a read-only consumer (`mehmory status`, `mehmory doctor`) must use this instead — a
 * CLI invocation that stole the warning would mean the user's next session never sees it.
 */
export function peekWarnings(): readonly string[] {
  return readWarningLines(statePath('warnings.json'));
}

/** Get pending warnings as formatted strings for injection. Returns and clears. */
export function pendingWarnings(): readonly string[] {
  const warningsPath = statePath('warnings.json');
  const lines = readWarningLines(warningsPath);

  if (!existsSync(warningsPath)) return lines;

  try {
    // Clear after reading (consume semantics for U2)
    const emptyJson = JSON.stringify([], null, 2);
    writeFileSync(warningsPath, emptyJson, 'utf-8');
    // Update cache since we just modified the file
    warningsCacheState = { warnings: [], contentHash: hashFileContents(emptyJson) };
  } catch {
    // Unwritable state dir: the lines were still read, so report them once rather
    // than swallowing them (A2).
  }

  return lines;
}
