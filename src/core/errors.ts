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

// All error codes for run 1, declared upfront. No other subtask edits this.
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

/** Log an error to <home>/.state/errors.log with 5 MB rotation (1 generation kept). */
export function logError(error: MehmoryError): void {
  const logPath = statePath('errors.log');
  const logDir = dirname(logPath);

  // Ensure .state directory exists
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
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

  // Append the line
  appendFileSync(logPath, line, 'utf-8');

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

  // Record warning for rate-limited injection (U2)
  recordWarning(error.code);
}

/** Safely call a function, returning fallback on any error and recording the error. */
export function failOpen<T>(
  fn: () => T,
  fallback: T,
  code: ErrorCode
): T {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = ERROR_KINDS[code];

    const error: MehmoryError =
      kind === 'actionable'
        ? {
            code,
            kind,
            what: message,
            consequence: 'Operation failed; using fallback',
            fix: 'See errors.log for details',
          }
        : {
            code,
            kind,
            what: message,
            consequence: 'Operation failed; using fallback',
          };

    logError(error);
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

/** Get pending warnings as formatted strings for injection. Returns and clears. */
export function pendingWarnings(): readonly string[] {
  const warningsPath = statePath('warnings.json');

  if (!existsSync(warningsPath)) {
    return [];
  }

  try {
    const data = readFileSync(warningsPath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    const warnings: WarningRecord[] = Array.isArray(parsed)
      ? parsed.filter(isWarningRecord)
      : [];

    const lines = warnings.map(w => {
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

    // Clear after reading (consume semantics for U2)
    const emptyJson = JSON.stringify([], null, 2);
    writeFileSync(warningsPath, emptyJson, 'utf-8');
    // Update cache since we just modified the file
    const contentHash = hashFileContents(emptyJson);
    warningsCacheState = { warnings: [], contentHash };

    return lines;
  } catch {
    return [];
  }
}
