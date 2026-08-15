/**
 * `mehmory stats` — criterion 10.
 *
 * Every number traces to a field some hook actually writes. The spec listed several
 * roll-ups nothing records; those were cut rather than invented, so an empty section
 * here means "no hook reports that", never "the aggregation is missing".
 */

import { join } from 'node:path';
import { storeExists } from '../../core/capture.js';
import { mehmoryHome } from '../../core/home.js';
import { listAgentScopes, listProjects } from '../../core/scopes.js';
import { aggregateStats } from '../../core/stats-report.js';
import { inboxAgeMs, integrateTimestamps, scopeFiles } from '../../core/status.js';
import { flagString, parseFlags } from '../args.js';
import { EXIT, storeMissing, usageError, type Command } from '../command.js';
import { SCOPE_FLAGS, scopeLabel, selectScope } from '../scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const command: Command = {
  name: 'stats',
  summary: 'aggregate hook latency, injection size and capture volume from stats.jsonl',
  usage: 'mehmory stats [--project [<key>]|--global|--agent [<name>]|--all] [--since <iso>] [--json]',
  help: [
    '  --project [<key>] one project; bare means the current directory (default)',
    '  --all             every project in the store',
    '  --since <iso>     only records at or after this ISO-8601 timestamp',
    '  --json            emit the single-line JSON envelope instead of text',
    '',
    '  `--global` and `--agent` are accepted but rejected: stats.jsonl records project',
    '  keys only.',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, { ...SCOPE_FLAGS, since: 'value' });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory stats --help');
    if (parsed.positional.length > 0) {
      return usageError(
        `\`stats\` takes no positional arguments (got \`${parsed.positional[0] ?? ''}\`)`,
        'mehmory stats --project'
      );
    }
    if (!storeExists()) return storeMissing('stats');

    const since = flagString(parsed.flags, 'since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      return usageError(`\`--since ${since}\` is not an ISO-8601 timestamp`, 'mehmory stats --since 2026-01-01');
    }

    const selected = selectScope(parsed.flags, ctx.cwd, ctx.config);
    if (!selected.ok) return selected.result;
    const scope = selected.scope;
    if (scope.kind === 'global' || scope.kind === 'agent') {
      // Accepted by the parser, rejected by the command (criterion 12): every stats
      // record carries a project key, so neither `global/` nor an agent scope has
      // anything to aggregate.
      return usageError(
        `\`stats --${scope.kind}\` has no records: stats.jsonl is keyed by project`,
        'mehmory stats --all'
      );
    }

    const keys = scope.kind === 'all' ? listProjects().map(p => p.key) : [scope.key];
    // `--all` deliberately aggregates every record in stats.jsonl, including keys with no
    // discoverable directory — a purged or renamed project keeps its history, which is the
    // point of asking for all of it. The `dirs`-derived figures below (inbox age, integrate
    // cadence) can only cover projects that still exist, so those two halves span different
    // populations by design; the output labels them so the report cannot be misread.
    const report = aggregateStats({
      ...(scope.kind === 'all' ? {} : { projects: keys }),
      ...(since !== undefined ? { since } : {}),
    });

    // Agent scopes carry no stats records, but they do have a `log.md`, so `--all`
    // includes them in the two directory-derived figures below and nowhere else.
    const dirs = [
      ...keys.map(key => join(mehmoryHome(), 'projects', key)),
      ...(scope.kind === 'all' ? listAgentScopes().map(a => a.dir) : []),
    ];
    const inboxAge = oldestInboxAgeMs(dirs);
    const cadence = integrateCadenceDays(dirs);

    const lines = [
      `scope    ${scopeLabel(scope)}${since === undefined ? '' : ` since ${since}`}`,
      `records  ${String(report.records)}`,
    ];
    for (const hook of report.hooks) {
      lines.push(
        `  ${hook.hook.padEnd(18)} ${String(hook.count).padStart(5)} calls   p50 ${String(hook.msP50)} ms   p95 ${String(hook.msP95)} ms`
      );
    }
    lines.push(
      report.injectedTokensP50 === undefined
        ? 'injection  no SessionStart records'
        : `injection  p50 ${String(report.injectedTokensP50)} tokens   p95 ${String(report.injectedTokensP95 ?? 0)} tokens`
    );
    lines.push(`pointers   ${String(report.pointersOffered)} offered`);
    lines.push(`captured   ${String(report.capturedEntries)} entries`);
    for (const host of report.hosts) {
      lines.push(
        `  ${host.host.padEnd(18)} ${String(host.count).padStart(5)} calls   ${String(host.capturedEntries)} captured`
      );
    }
    // Suffix only under `--all`, where the record counts above span every key in
    // stats.jsonl but these two can only read directories that still exist.
    const onDisk = scope.kind === 'all' ? ' (projects on disk)' : '';
    lines.push(
      inboxAge === undefined
        ? `inbox      no inbox yet${onDisk}`
        : `inbox      last written ${formatAge(inboxAge)} ago${onDisk}`
    );
    lines.push(
      cadence === undefined
        ? `integrate  fewer than two integrates recorded${onDisk}`
        : `integrate  every ${cadence.toFixed(1)} days on average${onDisk}`
    );

    return {
      exit: EXIT.OK,
      lines,
      data: {
        scope: scopeLabel(scope),
        projects: keys,
        ...(since !== undefined ? { since } : {}),
        ...report,
        ...(inboxAge !== undefined ? { inboxAgeMs: inboxAge } : {}),
        ...(cadence !== undefined ? { integrateCadenceDays: cadence } : {}),
      },
    };
  },
};

/** The most neglected inbox across the selected scopes — the number worth surfacing. */
function oldestInboxAgeMs(dirs: readonly string[]): number | undefined {
  const ages = dirs
    .map(dir => inboxAgeMs(scopeFiles(dir).inboxFile))
    .filter((age): age is number => age !== undefined);
  return ages.length === 0 ? undefined : Math.max(...ages);
}

/** Mean days between integrates across the selected scopes; undefined below two. */
function integrateCadenceDays(dirs: readonly string[]): number | undefined {
  const stamps = dirs
    .flatMap(dir => integrateTimestamps(scopeFiles(dir).logFile))
    .map(ts => Date.parse(ts))
    .filter(ms => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  if (stamps.length < 2 || first === undefined || last === undefined) return undefined;
  return (last - first) / (stamps.length - 1) / DAY_MS;
}

/** Compact human age, e.g. `3d 4h`. */
function formatAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / (60 * 60 * 1000));
  return days > 0 ? `${String(days)}d ${String(hours)}h` : `${String(hours)}h`;
}
