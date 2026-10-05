/**
 * `mehmory purge` — criterion 11.
 *
 * The confirmation grammar is this file's own work; everything it destroys is planned
 * and executed by `src/core/purge.ts` (A17).
 *
 * **How the typed token is supplied.** A command body may not write to stdout — the
 * framework owns the bytes (criterion 2) — so it cannot print a preview and then block
 * on a prompt. The sequence is two invocations instead of one, which is preview-first
 * either way: run it once to see exactly what would go and which token is required
 * (exit 4, nothing touched), then pipe that token in. `--yes` skips both.
 */

import { relative } from 'node:path';
import { storeExists } from '../../core/wiki.js';
import { readStdin } from '../../core/fs.js';
import { mehmoryHome } from '../../core/home.js';
import {
  executePurge,
  findPages,
  historyNotice,
  planAll,
  planGlobal,
  planIsEmpty,
  planPage,
  planProject,
  planSession,
  plannedEntries,
  shellQuote,
  type PageLocation,
  type PurgePlan,
} from '../../core/purge.js';
import { isSafeAgentName } from '../../core/agent-name.js';
import { flagString, parseFlags } from '../args.js';
import {
  EXIT,
  operationFailed,
  storeMissing,
  usageError,
  type Command,
  type CommandResult,
} from '../command.js';
import { selectScope, SCOPE_FLAGS } from '../scope.js';

/**
 * Exit 4's code. CLI-level, like `E_USAGE`: declining a confirmation is not a library
 * failure and must not enter `ERROR_KINDS`, which the docs are indexed by.
 */
const E_ABORTED = 'E_ABORTED';

/**
 * `--session` reaches exactly one copy of the data, and says so everywhere. Within that
 * limit it spans every inbox in the store (`planSession` walks `allInboxes()`): session ids
 * are unique, and a session that touched two projects is where a scoped purge would leave a
 * copy behind.
 */
const SESSION_REACH =
  '`--session` reaches un-integrated inbox entries only — `src=<id>` in the entry trailer is the only place session provenance survives. Content already integrated into a page is not reachable by session id. Within that limit it reaches every inbox in the store, not just the current scope.';

export const command: Command = {
  name: 'purge',
  summary: 'delete memory from the working tree and commit the removal',
  usage:
    'mehmory purge <page-slug> [--agent <name>] | --session <id> | --project [<key>] | --global | --all [--dry-run] [--export <path>] [--yes]',
  help: [
    '  <page-slug>       live and archived copies in one scope, plus matching index lines;',
    '                    includes agent scopes; ambiguous across scopes lists candidates,',
    '                    which `--project <key>`, `--global` or `--agent <name>` resolves',
    '  --session <id>    un-integrated inbox entries; at least 8 characters, no whitespace',
    '  --project [<key>] one project; bare means the current directory',
    '  --agent <name>    qualify a page slug with a safe single-segment agent name',
    '  --global          the entire global/ directory (including index, inbox, log, archive)',
    '  --all             everything in the store',
    '  --dry-run         preview the targets; deletes nothing',
    '  --export <path>   copy the targets there first; aborts if the copy fails',
    '  --yes             skip the typed confirmation',
    '  --json            emit the single-line JSON envelope instead of text',
    '',
    '  Without --yes the confirmation token is read from stdin; run the command once',
    '  to see the preview and the required token (exit 4), then:',
    "    printf '%s\\n' '<token>' | mehmory purge --all",
    '',
    `  ${SESSION_REACH}`,
    '',
    '  Purge deletes from the working tree and never rewrites git history.',
  ],

  run(ctx): CommandResult {
    const parsed = parseFlags(ctx.argv, {
      ...SCOPE_FLAGS,
      session: 'value',
      agent: 'value',
      'dry-run': 'boolean',
      export: 'value',
      yes: 'boolean',
    });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory purge --help');

    const slug = parsed.positional[0];
    if (parsed.positional.length > 1) {
      return usageError('`purge` takes at most one page slug', 'mehmory purge --help');
    }

    // A scope flag beside a slug is a *qualifier* on that page, not a second target —
    // it is how an ambiguous slug is resolved. Everything else is exclusive.
    const forms = [
      parsed.flags.has('session') ? '--session' : undefined,
      parsed.flags.has('project') ? '--project' : undefined,
      parsed.flags.has('agent') ? '--agent' : undefined,
      parsed.flags.has('global') ? '--global' : undefined,
      parsed.flags.has('all') ? '--all' : undefined,
    ].filter((form): form is string => form !== undefined);

    if (forms.length === 0 && slug === undefined) {
      return usageError('`purge` needs something to delete', 'mehmory purge --help');
    }
    if (forms.length > 1) {
      return usageError(
        `\`purge\` deletes one thing at a time (got ${forms.join(' and ')})`,
        'mehmory purge --help'
      );
    }
    if (slug !== undefined && (parsed.flags.has('session') || parsed.flags.has('all'))) {
      return usageError(
        `\`${forms[0] ?? ''}\` cannot be combined with a page slug`,
        'mehmory purge --help'
      );
    }
    const agent = flagString(parsed.flags, 'agent');
    if (agent !== undefined && !isSafeAgentName(agent)) {
      return usageError(
        '`--agent` requires a safe single-segment agent name',
        'mehmory purge --help'
      );
    }
    if (parsed.flags.has('agent') && slug === undefined) {
      return usageError('`--agent` requires a page slug', 'mehmory purge --help');
    }
    const session = flagString(parsed.flags, 'session');
    if (session !== undefined && (session.length < 8 || /\s/u.test(session))) {
      return usageError(
        '`--session` requires at least 8 characters with no whitespace',
        'mehmory purge --help'
      );
    }
    if (!storeExists()) return storeMissing('purge');

    const planned = buildPlan(slug, parsed.flags, ctx);
    if ('result' in planned) return planned.result;
    const plan = planned.plan;

    const home = mehmoryHome();
    const targets = plan.paths.map(path => relative(home, path));
    const entries = plannedEntries(plan);
    const dryRun = parsed.flags.has('dry-run');
    const preview = [
      `purge    ${plan.label}`,
      ...targets.map(path => `  delete ${path}`),
      ...plan.indexEdits.flatMap(edit => [
        `  clear  ${String(edit.lines.length)} index lines in ${relative(home, edit.indexFile)}`,
        ...edit.lines.map(line => `    ${line}`),
      ]),
      ...(entries > 0
        ? [
            `  clear  ${String(entries)} inbox entries in ${String(plan.inboxEdits.length)} scope(s)`,
          ]
        : []),
      ...(plan.form === 'global'
        ? [
            '  note   no global skeleton survives; a later init or SessionStart may recreate empty templates',
          ]
        : []),
    ];
    const data = {
      form: plan.form,
      scope: plan.label,
      targets,
      entries,
      indexEdits: plan.indexEdits.map(edit => ({
        file: relative(home, edit.indexFile),
        lines: edit.lines,
      })),
      token: plan.token,
      dryRun,
      ...(plan.form === 'session' ? { reach: SESSION_REACH } : {}),
    };

    if (planIsEmpty(plan)) {
      return { exit: EXIT.OK, lines: [`nothing to delete for ${plan.label}`], data };
    }

    const notice = [
      ...historyNotice(plan),
      ...(plan.form === 'session' ? [`note: ${SESSION_REACH}`] : []),
    ];

    if (dryRun) {
      return {
        exit: EXIT.OK,
        lines: [...preview, '', 'dry run — nothing was deleted', ...notice],
        data: { ...data, deleted: false },
      };
    }

    if (!parsed.flags.has('yes')) {
      // A TTY has no piped token to read, and reading fd 0 there would hang the shell
      // waiting for EOF. Both cases land on the same preview-and-abort.
      const typed = process.stdin.isTTY ? '' : readStdin().trim();
      if (typed !== plan.token) {
        return {
          exit: EXIT.ABORTED,
          lines: [...preview, '', ...notice],
          data: { ...data, deleted: false },
          errors: [
            {
              code: E_ABORTED,
              what:
                typed === ''
                  ? `confirmation required: this deletes ${String(targets.length + entries)} target(s)`
                  : `\`${typed}\` is not the confirmation token for ${plan.label}`,
              consequence: 'Nothing was deleted',
              fix: `printf '%s\\n' ${shellQuote(plan.token)} | mehmory ${['purge', ...ctx.argv]
                .filter(a => a !== '--json')
                .map(shellQuote)
                .join(' ')}`,
            },
          ],
        };
      }
    }

    const outcome = executePurge(plan, flagString(parsed.flags, 'export'));
    if (!outcome.ok) {
      const failed = operationFailed(outcome.error);
      return {
        ...failed,
        lines: [...preview, '', ...(outcome.deleted ? notice : [])],
        data: { ...data, deleted: outcome.deleted },
      };
    }

    return {
      exit: EXIT.OK,
      lines: [
        ...preview,
        '',
        `deleted  ${String(outcome.removed)} path(s)${outcome.entries > 0 ? `, ${String(outcome.entries)} inbox entries` : ''}${outcome.indexLines > 0 ? `, ${String(outcome.indexLines)} index lines` : ''} and committed the removal`,
        ...notice,
      ],
      data: {
        ...data,
        deleted: true,
        removed: outcome.removed,
        clearedEntries: outcome.entries,
        clearedIndexLines: outcome.indexLines,
      },
    };
  },
};

/** Turn the selected form into a plan, or into the result that replaces it. */
function buildPlan(
  slug: string | undefined,
  flags: ReadonlyMap<string, string | boolean>,
  ctx: { readonly cwd: string; readonly config: Parameters<typeof selectScope>[2] }
): { readonly plan: PurgePlan } | { readonly result: CommandResult } {
  if (slug !== undefined) {
    // An optional scope qualifier, which is what makes the ambiguity error's `fix` a
    // command that actually resolves it.
    let restrict: { kind: PageLocation['kind']; key: string } | undefined;
    if (flags.has('global')) {
      restrict = { kind: 'global', key: 'global' };
    } else if (flags.has('project')) {
      const scoped = selectScope(flags, ctx.cwd, ctx.config);
      if (!scoped.ok) return { result: scoped.result };
      if (scoped.scope.kind === 'project') restrict = { kind: 'project', key: scoped.scope.key };
    } else {
      const agent = flagString(flags, 'agent');
      if (agent !== undefined) restrict = { kind: 'agent', key: agent };
    }

    const pages = findPages(slug).filter(
      page => restrict === undefined || (page.kind === restrict.kind && page.key === restrict.key)
    );
    const page = pages[0];
    if (page === undefined) {
      return {
        result: usageError(
          `no page \`${slug}\`${restrict === undefined ? ' in any scope' : ` in ${restrict.kind} ${restrict.key}`}`,
          `mehmory search ${slug}`
        ),
      };
    }
    const scopes = [...new Map(pages.map(p => [p.dir, p])).values()];
    if (scopes.length > 1) {
      // Never both. The user names the scope and runs it again.
      const other = scopes.find(p => p.kind !== 'global');
      return {
        result: usageError(
          `\`${slug}\` exists in ${String(scopes.length)} scopes: ${scopes.map(p => p.scope).join(', ')}`,
          other === undefined
            ? `mehmory purge ${slug} --global`
            : `mehmory purge ${slug} --${other.kind === 'agent' ? 'agent' : 'project'} ${other.key}`
        ),
      };
    }
    return { plan: planPage(slug, page.path, page.scope) };
  }

  if (flags.has('all')) return { plan: planAll() };
  if (flags.has('global')) return { plan: planGlobal() };

  if (flags.has('project')) {
    const scoped = selectScope(flags, ctx.cwd, ctx.config);
    if (!scoped.ok) return { result: scoped.result };
    if (scoped.scope.kind !== 'project') {
      return { result: usageError('`--project` did not resolve to a project', 'mehmory status') };
    }
    return { plan: planProject(scoped.scope.key, scoped.scope.dir) };
  }

  const session = flagString(flags, 'session');
  if (session !== undefined) return { plan: planSession(session) };
  return { result: usageError('`--session` requires an id', 'mehmory purge --help') };
}
