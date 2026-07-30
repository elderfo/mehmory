/**
 * Instrumentation sink: one JSONL line per hook invocation in `.state/stats.jsonl`.
 *
 * Same append/rotation protocol as `errors.log` (A8: 5 MB, one generation kept) and
 * the same atomicity guarantee as every other record (one `\n`-terminated line per
 * `appendRecord` call). Latency budgets are measured from this file, not asserted in CI.
 */

import { statePath } from './home.js';
import { appendRecord, pathExists, readFileFrom, rename, stat as statFile } from './fs.js';
import { withProjectLock } from './lock.js';
import { failOpen } from './errors.js';
import { loadConfig } from './config.js';

/** One instrumentation record (plan criterion 16). Extra fields are allowed. */
export interface StatInput {
  /** ISO-8601 timestamp; filled in by `recordStat` when omitted. */
  ts?: string;
  /** Resolved project key slug (never a path hash — spec gap 15). */
  project: string;
  /** Hook name, e.g. `SessionStart`. */
  hook: string;
  /** Wall time of the invocation in ms. */
  ms: number;
  /** Optional per-hook measurements: injected_tokens, pointers_offered, … */
  [key: string]: unknown;
}

/** A stats record as it appears on disk: an input with the timestamp filled in. */
export type StatRecord = StatInput & { ts: string };

/** Path of the stats file. */
export function statsPath(): string {
  return statePath('stats.jsonl');
}

/** Rotate stats.jsonl once it passes the configured size (A8: 5 MB, 1 generation). */
function rotateIfNeeded(path: string): void {
  const maxBytes = loadConfig().log.rotation_size_mb * 1024 * 1024;
  if (!pathExists(path)) return;
  const size = Number(statFile(path)?.size ?? 0);
  if (size <= maxBytes) return;
  rename(path, `${path}.1`);
}

/**
 * Append one stats line. Never throws: instrumentation must not be able to break a
 * hook (A2).
 */
export function recordStat(record: StatInput): void {
  failOpen(
    () => {
      const path = statsPath();
      rotateIfNeeded(path);
      const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
      appendRecord(path, line, record.project, withProjectLock);
    },
    undefined,
    'E_APPEND_FAILED'
  );
}

/**
 * Newest stats entry for a project/hook pair, or undefined if there is none.
 *
 * UserPromptSubmit uses this to notice a SessionStart that never ran (or ran long ago)
 * and drain a pending warning itself — otherwise the failure and its only reporting
 * channel are the same process.
 *
 * ponytail: scans the tail of the file (bounded by the rotation size). Upgrade path if
 * that ever costs: a `.state/last-stat.json` written alongside each append.
 */
export function lastStatFor(project: string, hook: string): StatRecord | undefined {
  return failOpen(
    () => {
      const path = statsPath();
      if (!pathExists(path)) return undefined;

      // Only the tail can hold the newest entry; 64 KiB is thousands of lines.
      const size = Number(statFile(path)?.size ?? 0);
      const contents = readFileFrom(path, Math.max(0, size - 64 * 1024));
      const lines = contents.split('\n');

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line?.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // partial first line after the offset cut, or a torn write
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const rec = parsed as Record<string, unknown>;
        if (rec['project'] === project && rec['hook'] === hook) return rec as StatRecord;
      }
      return undefined;
    },
    undefined,
    'E_APPEND_FAILED'
  );
}
