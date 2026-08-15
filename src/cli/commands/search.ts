/**
 * `mehmory search` — criterion 6.
 *
 * Thin per A17: flags in, `src/core/search.ts` scans, this file only shapes the
 * `CommandResult`. One scan over pages + archive + log per selected scope, no index
 * and no capability probe (A18/U12) — every user gets the same corpus and result
 * shape, so there is nothing to degrade.
 */

import { join } from 'node:path';
import { storeExists } from '../../core/capture.js';
import { mehmoryHome } from '../../core/home.js';
import { AGENT_SCOPE_PREFIX, listAgentScopes, listProjects } from '../../core/scopes.js';
import { searchScope, type SearchHit } from '../../core/search.js';
import { scopeFiles } from '../../core/status.js';
import { ARCHIVE_DIR } from '../../schema/format.js';
import { flagInteger, parseFlags } from '../args.js';
import { EXIT, storeMissing, usageError, type Command } from '../command.js';
import { SCOPE_FLAGS, scopeLabel, selectScope } from '../scope.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const command: Command = {
  name: 'search',
  summary: 'rank hits across the pages, archive and log of the selected scopes',
  usage:
    'mehmory search <query> [--project [<key>]|--global|--agent [<name>]|--all] [--limit N] [--json]',
  help: [
    '  <query>           text to search for',
    '  --project [<key>] one project; bare means the current directory (default)',
    '  --global          the global scope',
    '  --agent [<name>]  one agent scope; bare means the agent running this session',
    '  --all             every scope in the store',
    '  --limit N         maximum hits to return (default 10, capped at 100)',
    '  --json            emit the single-line JSON envelope instead of text',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, { ...SCOPE_FLAGS, limit: 'value' });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory search --help');
    if (parsed.positional.length !== 1) {
      return usageError(
        `\`search\` takes exactly one query argument (got ${String(parsed.positional.length)})`,
        'mehmory search --help'
      );
    }
    const query = parsed.positional[0] ?? '';

    const limitParsed = flagInteger(parsed.flags, 'limit');
    if (!limitParsed.ok) return usageError(limitParsed.what, 'mehmory search --help');
    const limit = Math.min(limitParsed.value ?? DEFAULT_LIMIT, MAX_LIMIT);

    if (!storeExists()) return storeMissing('search');

    const selected = selectScope(parsed.flags, ctx.cwd, ctx.config);
    if (!selected.ok) return selected.result;
    const scope = selected.scope;

    // Every scope but `--all` names exactly one directory, and `scopeLabel` is already
    // the label those hits carry — the fan-out is the only case that has to enumerate.
    const targets: readonly { readonly label: string; readonly dir: string }[] =
      scope.kind === 'all'
        ? [
            { label: 'global', dir: join(mehmoryHome(), 'global') },
            ...listProjects().map(p => ({ label: p.key, dir: p.dir })),
            ...listAgentScopes().map(a => ({ label: AGENT_SCOPE_PREFIX + a.name, dir: a.dir })),
          ]
        : [{ label: scopeLabel(scope), dir: scope.dir }];

    const warnings: string[] = [];
    let hits: SearchHit[] = [];
    for (const target of targets) {
      const files = scopeFiles(target.dir);
      const scan = searchScope(
        query,
        target.label,
        {
          pagesDir: files.pagesDir,
          archiveDir: join(target.dir, ARCHIVE_DIR),
          logFile: files.logFile,
        },
        { staleAfterDays: ctx.config.decay.archive_days }
      );
      hits.push(...scan.hits);
      warnings.push(...scan.warnings);
    }

    hits.sort(
      (a, b) => b.score - a.score || a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path)
    );

    const total = hits.length;
    if (total > limit) {
      warnings.push(`returned the top ${String(limit)} of ${String(total)} hits (--limit)`);
    }
    hits = hits.slice(0, limit);

    const lines =
      hits.length === 0
        ? [`no hits for \`${query}\` in ${scopeLabel(scope)}`]
        : hits.map(
            hit =>
              `${hit.path} (${hit.scope})${hit.stale ? ' [stale]' : ''}  score=${String(hit.score)}\n  ${hit.snippet}`
          );

    return {
      exit: EXIT.OK,
      lines,
      data: { query, scope: scopeLabel(scope), limit, hits },
      warnings,
    };
  },
};
