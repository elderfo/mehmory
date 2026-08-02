/**
 * Aggregation over `.state/stats.jsonl` for `mehmory stats` and for `doctor`'s KPI and
 * hook-liveness checks (criteria 8 and 10).
 *
 * **Only fields that exist are aggregated.** The spec listed several roll-ups no hook
 * ever writes; those were cut rather than faked (plan gap 11), so every number here
 * traces back to a key some `src/hooks/*.ts` actually records.
 *
 * `src/core/stats.ts` owns writing this file; this module only reads it.
 */

import { pathExists, readFile } from './fs.js';
import { failOpen } from './errors.js';
import { statsPath, type StatRecord } from './stats.js';

/** Which records to aggregate. */
export interface StatsFilter {
  /** Project keys to include. Undefined means every project. */
  readonly projects?: readonly string[];
  /** Only records at or after this ISO timestamp. */
  readonly since?: string;
}

/** Per-hook roll-up. */
export interface HookAggregate {
  readonly hook: string;
  readonly count: number;
  /** Wall-time percentiles in ms, from the `ms` field every record carries. */
  readonly msP50: number;
  readonly msP95: number;
}

/** Per-harness roll-up (issue #14 story 39). Every hook record carries `host` (A21/A23). */
export interface HostAggregate {
  readonly host: string;
  readonly count: number;
  /** Sum of `captured_entries` for this harness. */
  readonly capturedEntries: number;
}

/** Everything `mehmory stats` reports from `stats.jsonl`. */
export interface StatsReport {
  readonly records: number;
  readonly hooks: readonly HookAggregate[];
  /** From SessionStart's `injected_tokens`. Undefined when no record carries it. */
  readonly injectedTokensP50?: number;
  readonly injectedTokensP95?: number;
  /** Sum of UserPromptSubmit's `pointers_offered`. */
  readonly pointersOffered: number;
  /** Sum of `captured_entries` across every hook that captures. */
  readonly capturedEntries: number;
  /** Same records as `hooks`, split by harness instead of by hook name. */
  readonly hosts: readonly HostAggregate[];
}

/**
 * Nearest-rank percentile: the smallest value at or above which `p` of the samples lie.
 *
 * Nearest-rank rather than interpolation because these are latency samples read off a
 * log — an interpolated p95 reports a millisecond count that never happened.
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/** Every parseable record in `stats.jsonl` that passes the filter, oldest first. */
export function readStats(filter: StatsFilter = {}): readonly StatRecord[] {
  return failOpen(
    () => {
      const path = statsPath();
      if (!pathExists(path)) return [];

      const wanted = filter.projects === undefined ? undefined : new Set(filter.projects);
      const records: StatRecord[] = [];
      for (const line of readFile(path).split('\n')) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // a torn write is a skipped sample, not a failed command
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (typeof record['ts'] !== 'string' || typeof record['hook'] !== 'string') continue;
        if (typeof record['project'] !== 'string' || typeof record['ms'] !== 'number') continue;
        if (filter.since !== undefined && record['ts'] < filter.since) continue;
        if (wanted !== undefined && !wanted.has(record['project'])) continue;
        records.push(record as StatRecord);
      }
      return records;
    },
    [],
    'E_SEARCH_FAILED'
  );
}

/** Roll up the filtered records. */
export function aggregateStats(filter: StatsFilter = {}): StatsReport {
  return summarize(readStats(filter));
}

/** Roll up records already read (doctor reads once and asks several questions). */
export function summarize(records: readonly StatRecord[]): StatsReport {
  const byHook = new Map<string, number[]>();
  const byHost = new Map<string, { count: number; capturedEntries: number }>();
  const injected: number[] = [];
  let pointersOffered = 0;
  let capturedEntries = 0;

  for (const record of records) {
    const samples = byHook.get(record.hook) ?? [];
    samples.push(record.ms);
    byHook.set(record.hook, samples);

    const tokens = record['injected_tokens'];
    if (typeof tokens === 'number') injected.push(tokens);
    const pointers = record['pointers_offered'];
    if (typeof pointers === 'number') pointersOffered += pointers;
    const captured = record['captured_entries'];
    if (typeof captured === 'number') capturedEntries += captured;

    const host = record['host'];
    if (typeof host === 'string') {
      const entry = byHost.get(host) ?? { count: 0, capturedEntries: 0 };
      entry.count += 1;
      if (typeof captured === 'number') entry.capturedEntries += captured;
      byHost.set(host, entry);
    }
  }

  const hooks: HookAggregate[] = [...byHook.entries()]
    .map(([hook, samples]) => ({
      hook,
      count: samples.length,
      msP50: percentile(samples, 0.5) ?? 0,
      msP95: percentile(samples, 0.95) ?? 0,
    }))
    .sort((a, b) => a.hook.localeCompare(b.hook));

  const hosts: HostAggregate[] = [...byHost.entries()]
    .map(([host, agg]) => ({ host, count: agg.count, capturedEntries: agg.capturedEntries }))
    .sort((a, b) => a.host.localeCompare(b.host));

  const p50 = percentile(injected, 0.5);
  const p95 = percentile(injected, 0.95);

  return {
    records: records.length,
    hooks,
    ...(p50 !== undefined ? { injectedTokensP50: p50 } : {}),
    ...(p95 !== undefined ? { injectedTokensP95: p95 } : {}),
    pointersOffered,
    capturedEntries,
    hosts,
  };
}
