/**
 * `mehmory status` — criterion 9.
 *
 * Reads only. Pending warnings come from `peekWarnings()` inside `buildStatus`; using
 * `pendingWarnings()` would consume them, and that is SessionStart's only channel — a
 * `status` run would silently be the last place the user ever saw the warning.
 */

import { join } from 'node:path';
import { storeExists } from '../../core/capture.js';
import { mehmoryHome } from '../../core/home.js';
import { resolveProjectKey } from '../../core/identity.js';
import { buildStatus } from '../../core/status.js';
import { resolveScope } from '../../core/scopes.js';
import { parseFlags } from '../args.js';
import { EXIT, storeMissing, usageError, type Command } from '../command.js';

export const command: Command = {
  name: 'status',
  summary: 'one screen: scope, pages, index, inbox, last integrate, last commit',
  usage: 'mehmory status [--json]',
  help: ['  --json            emit the single-line JSON envelope instead of text'],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, {});
    if (!parsed.ok) return usageError(parsed.what, 'mehmory status --help');
    if (parsed.positional.length > 0) {
      return usageError(
        `\`status\` takes no arguments (got \`${parsed.positional[0] ?? ''}\`)`,
        'mehmory status'
      );
    }
    if (!storeExists()) return storeMissing('status');

    const key = resolveProjectKey(ctx.cwd);
    const resolution = resolveScope(key, ctx.config);
    const dir =
      resolution.kind === 'match'
        ? resolution.project.dir
        : join(mehmoryHome(), 'projects', key);

    const report = buildStatus(key, dir);
    const lines = [
      `scope    project ${report.key}`,
      `store    ${report.dir}`,
      `pages    ${String(report.pages)}`,
      `index    ${String(report.indexLines)} lines`,
      `inbox    ${String(report.inboxEntries)} entries${report.oldestInbox === undefined ? '' : `, oldest ${report.oldestInbox}`}`,
      `integrate ${report.lastIntegrate ?? 'never'}`,
      `commit   ${report.lastCommit ?? 'none'}`,
      `warnings ${report.warnings.length === 0 ? 'none' : String(report.warnings.length) + ' pending'}`,
    ];

    return {
      exit: EXIT.OK,
      lines,
      data: { scope: 'project', ...report },
      warnings: report.warnings,
    };
  },
};
