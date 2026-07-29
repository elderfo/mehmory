import {
  appendFileSync,
  readFileSync,
  existsSync,
  statSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
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

  // Append the line
  appendFileSync(logPath, line, 'utf-8');

  // Rotate if over 5 MB
  const maxSize = 5 * 1024 * 1024;
  try {
    const stat = statSync(logPath);
    if (stat.size > maxSize) {
      // Rotate: move current to .1, start fresh
      const rotatedPath = statePath('errors.log.1');
      renameSync(logPath, rotatedPath);
    }
  } catch {
    // Stat/rotate failed, ignore (don't create a loop)
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

const WARN_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

/** Record a warning (rate-limited to 1 per hour per code). Marks as delivered when read. */
export function recordWarning(code: ErrorCode): void {
  const warningsPath = statePath('warnings.json');
  const warningsDir = dirname(warningsPath);

  if (!existsSync(warningsDir)) {
    mkdirSync(warningsDir, { recursive: true });
  }

  let warnings: WarningRecord[] = [];
  if (existsSync(warningsPath)) {
    try {
      const data = readFileSync(warningsPath, 'utf-8');
      warnings = JSON.parse(data);
    } catch {
      warnings = [];
    }
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
    writeFileSync(warningsPath, JSON.stringify(warnings, null, 2), 'utf-8');
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
    const warnings: WarningRecord[] = JSON.parse(data);

    const lines = warnings.map(w => {
      const kind = ERROR_KINDS[w.code as ErrorCode] ?? 'informational';
      return `${w.code} (${kind}, ${w.count} occurrences): see ~/.mehmory/.state/errors.log`;
    });

    // Clear after reading (consume semantics for U2)
    writeFileSync(warningsPath, JSON.stringify([], null, 2), 'utf-8');

    return lines;
  } catch {
    return [];
  }
}
