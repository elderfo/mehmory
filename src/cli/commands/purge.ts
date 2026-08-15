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
import { storeExists } from '../../core/capture.js';
import { readStdin } from '../../core/fs.js';
import { mehmoryHome } from '../../core/home.js';
import { AGENT_SCOPE_PREFIX } from '../../core/scopes.js';
import {
  executePurge,
  findPages,
  historyNotice,
  planAgent,
  planAll,
  planGlobal,
  planIsEmpty,
  planPage,
  planProject,
  planSession,
  plannedEntries,
  type PurgePlan,
} from '../../core/purge.js';
import { flagString, parseFlags } from '../args.js';
import {
  EXIT,
  operationFailed,
  storeMissing,
  usageError,
  type Command,
  type CommandResult,
} from '../command.js';
import { scopeLabel, selectScope, SCOPE_FLAGS } from '../scope.js';

/** The scope flag that narrows an ambiguous page slug to the scope holding it. */
function scopeQualifier(scope: string): string {
  return scope.startsWith(AGENT_SCOPE_PREFIX)
    ? `--agent ${scope.slice(AGENT_SCOPE_PREFIX.length)}`
    : `--project ${scope}`;
}

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

/**
 * The same disclosure for `--agent`, and the same reason: the sweep reaches past the
 * scope directory in a way the flag name does not suggest.
 *
 * The stamp records which agent was *running* when an entry was captured, not what the
 * entry is about, so every capture a named agent made carries it — including the project
 * observations that integration would have filed to the project scope.
 */
const AGENT_REACH =
  '`--agent` deletes the agent scope and every un-integrated inbox entry stamped with that name, in every project. The stamp marks which agent captured an entry, not what it is about, so this also deletes that agent\'s un-integrated project observations. Integrated pages are untouched — integrate first to keep that work.';

export const command: Command = {
  name: 'purge',
  summary: 'delete memory from the working tree and commit the removal',
  usage:
    'mehmory purge <page-slug> | --session <id> | --project [<key>] | --global | --agent [<name>] | --all [--dry-run] [--export <path>] [--yes]',
  help: [
    '  <page-slug>       one page; ambiguous across scopes exits 1 listing candidates,',
    '                    which `--project <key>`, `--global` or `--agent <name>` beside',
    '                    the slug resolves',
    '  --session <id>    un-integrated inbox entries captured by that session',
    '  --project [<key>] one project; bare means the current directory',
    '  --global          identity.md and global/pages/',
    '  --agent [<name>]  one agent scope, plus every inbox entry stamped with that name;',
    '                    bare means the agent running this session',
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
    `  ${AGENT_REACH}`,
    '',
    '  Purge deletes from the working tree and never rewrites git history.',
  ],

  run(ctx): CommandResult {
    const parsed = parseFlags(ctx.argv, {
      ...SCOPE_FLAGS,
      session: 'value',
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
      parsed.flags.has('global') ? '--global' : undefined,
      parsed.flags.has('agent') ? '--agent' : undefined,
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
      ...(entries > 0
        ? [`  clear  ${String(entries)} inbox entries in ${String(plan.inboxEdits.length)} scope(s)`]
        : []),
    ];
    const data = {
      form: plan.form,
      scope: plan.label,
      targets,
      entries,
      token: plan.token,
      dryRun,
      ...(plan.form === 'session' ? { reach: SESSION_REACH } : {}),
      ...(plan.form === 'agent' ? { reach: AGENT_REACH } : {}),
    };

    if (planIsEmpty(plan)) {
      return { exit: EXIT.OK, lines: [`nothing to delete for ${plan.label}`], data };
    }

    const notice = [
      ...historyNotice(plan),
      ...(plan.form === 'session' ? [`note: ${SESSION_REACH}`] : []),
      ...(plan.form === 'agent' ? [`note: ${AGENT_REACH}`] : []),
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
              fix: `printf '%s\\n' '${plan.token}' | mehmory ${['purge', ...ctx.argv].filter(a => a !== '--json').join(' ')}`,
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
        `deleted  ${String(outcome.removed)} path(s)${outcome.entries > 0 ? `, ${String(outcome.entries)} inbox entries` : ''} and committed the removal`,
        ...notice,
      ],
      data: { ...data, deleted: true, removed: outcome.removed, clearedEntries: outcome.entries },
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
    let restrict: string | undefined;
    if (flags.has('global')) {
      restrict = 'global';
    } else if (flags.has('project') || flags.has('agent')) {
      const scoped = selectScope(flags, ctx.cwd, ctx.config);
      if (!scoped.ok) return { result: scoped.result };
      restrict = scoped.scope.kind === 'all' ? undefined : scopeLabel(scoped.scope);
    }

    const pages = findPages(slug).filter(page => restrict === undefined || page.scope === restrict);
    const page = pages[0];
    if (page === undefined) {
      return {
        result: usageError(
          `no page \`${slug}\`${restrict === undefined ? ' in any scope' : ` in ${restrict}`}`,
          `mehmory search ${slug}`
        ),
      };
    }
    if (pages.length > 1) {
      // Never both. The user names the scope and runs it again.
      const other = pages.find(p => p.scope !== 'global');
      return {
        result: usageError(
          `\`${slug}\` exists in ${String(pages.length)} scopes: ${pages.map(p => p.scope).join(', ')}`,
          other === undefined
            ? `mehmory purge ${slug} --global`
            : `mehmory purge ${slug} ${scopeQualifier(other.scope)}`
        ),
      };
    }
    return { plan: planPage(slug, page.path, page.scope) };
  }

  if (flags.has('all')) return { plan: planAll() };
  if (flags.has('global')) return { plan: planGlobal() };

  if (flags.has('agent')) {
    const scoped = selectScope(flags, ctx.cwd, ctx.config);
    if (!scoped.ok) return { result: scoped.result };
    if (scoped.scope.kind !== 'agent') {
      return { result: usageError('`--agent` did not resolve to an agent', 'mehmory status') };
    }
    return { plan: planAgent(scoped.scope.name, scoped.scope.dir) };
  }

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
