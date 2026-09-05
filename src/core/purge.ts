/**
 * `mehmory purge` — the only path in the product that destroys user data (criterion 11).
 *
 * Two rules shape everything here. **A19:** purge deletes from the working tree and
 * commits the removal; it never rewrites the store's git history, so the caller is
 * given the `git filter-repo` recipe to run itself. **U11:** every form previews first
 * and is gated on a typed token whose length scales with the blast radius, which is why
 * the token is computed here, next to the targets, rather than in the command file.
 *
 * A11 still binds: nothing here exits or prompts. It returns plans and outcomes.
 */

import { basename, join, relative, resolve, sep } from 'node:path';
import {
  atomicWrite,
  listDir,
  lstat,
  readFileFromNoFollow,
  realpath,
  mkdir,
  pathExists,
  readFile,
  remove,
  removeDir,
  stat,
} from './fs.js';
import { mehmoryHome } from './home.js';
import { commitPaths, ensureGitBaseline } from './git.js';
import { withProjectLock } from './lock.js';
import { clearInboxEntries, readInboxEntries } from './inbox.js';
import { parseInboxEntries } from '../schema/format.js';
import { listProjects } from './scopes.js';
import type { MehmoryError } from './errors.js';

/** The five things a user can delete, in ascending blast radius. */
export type PurgeForm = 'page' | 'session' | 'global' | 'project' | 'all';

/** Inbox entries a `--session` purge removes, grouped by the inbox holding them. */
export interface InboxEdit {
  readonly inboxFile: string;
  /** Project key (or `global`) — the lock key `clearInboxEntries` needs. */
  readonly key: string;
  readonly ids: readonly string[];
}

/** Everything the preview shows and the execution needs. */
export interface PurgePlan {
  readonly form: PurgeForm;
  /** What the user asked to delete, echoed back resolved. */
  readonly label: string;
  /** The token that must be typed to proceed (U11). */
  readonly token: string;
  /** Files and directories to remove, absolute. */
  readonly paths: readonly string[];
  readonly inboxEdits: readonly InboxEdit[];
}

/** A bare page slug that exists in more than one scope. Never deleted from both. */
export interface PageCandidates {
  readonly slug: string;
  /** Scope labels holding a page with that slug, sorted. */
  readonly scopes: readonly string[];
}

/** Where a page with a given slug lives. */
export function findPages(slug: string): readonly { scope: string; path: string }[] {
  if (slug !== basename(slug) || slug === '.' || slug === '..' || slug.includes('\u0000')) return [];

  const home = mehmoryHome();
  const found: { scope: string; path: string }[] = [];
  const candidates: { scope: string; dir: string }[] = [
    { scope: 'global', dir: join(home, 'global', 'pages') },
    ...listProjects().map(p => ({ scope: p.key, dir: join(p.dir, 'pages') })),
  ];
  for (const { scope, dir } of candidates) {
    const path = join(dir, `${slug}.md`);
    if (pathExists(path)) found.push({ scope, path });
  }
  return found.sort((a, b) => a.scope.localeCompare(b.scope));
}

/** Every inbox in the store, with the key its lock uses. */
function allInboxes(): readonly { inboxFile: string; key: string }[] {
  const home = mehmoryHome();
  return [
    { inboxFile: join(home, 'global', 'inbox.md'), key: 'global' },
    ...listProjects().map(p => ({ inboxFile: join(p.dir, 'inbox.md'), key: p.key })),
  ];
}

/**
 * The plan for `--session <id>`.
 *
 * Deliberately narrow: `src=<sessionId>` in an inbox entry's trailer is the only place
 * session provenance survives at all. Once an entry is integrated into a page it is
 * editorial prose with no session field (`refs` is optional frontmatter), so a session
 * purge reaches un-integrated entries and nothing else. The command says so in its
 * output as well as its `--help` — a deletion that silently under-reaches is worse
 * than one that refuses.
 */
export function planSession(sessionId: string): PurgePlan {
  const edits: InboxEdit[] = [];
  for (const { inboxFile, key } of allInboxes()) {
    const ids = readInboxEntries(inboxFile)
      .filter(entry => entry.src === sessionId)
      .map(entry => entry.id);
    if (ids.length > 0) edits.push({ inboxFile, key, ids });
  }
  return {
    form: 'session',
    label: `session ${sessionId}`,
    // The last 8 characters, which is what the preview shows: a full uuid is a
    // copy-paste, not a confirmation.
    token: sessionId.slice(-8),
    paths: [],
    inboxEdits: edits,
  };
}

/** The plan for a bare page slug, once it has been resolved to exactly one scope. */
export function planPage(slug: string, path: string, scope: string): PurgePlan {
  return { form: 'page', label: `page ${slug} (${scope})`, token: slug, paths: [path], inboxEdits: [] };
}

/** The plan for `--project [<key>]`: the whole project directory. */
export function planProject(key: string, dir: string): PurgePlan {
  // The token is the **resolved** key, never the substring the user typed — otherwise
  // `--project widget` would be confirmed by typing `widget` while deleting
  // `github.com/acme/widgets`.
  return {
    form: 'project',
    label: `project ${key}`,
    token: key,
    paths: pathExists(dir) ? [dir] : [],
    inboxEdits: [],
  };
}

/**
 * The plan for `--global`: `identity.md` and `global/pages/`.
 *
 * A scope in its own right, not a subset of `--all`: this is the most personal content
 * in the store and reaching it must not require nuking every project first.
 */
export function planGlobal(): PurgePlan {
  const dir = join(mehmoryHome(), 'global');
  return {
    form: 'global',
    label: 'global memory (identity.md and global/pages/)',
    token: 'global',
    paths: [join(dir, 'identity.md'), join(dir, 'pages')].filter(p => pathExists(p)),
    inboxEdits: [],
  };
}

/** The plan for `--all`: every scope's memory. The repo, config and schema stay. */
export function planAll(): PurgePlan {
  const home = mehmoryHome();
  return {
    form: 'all',
    label: 'all memory in ' + home,
    token: 'DELETE ALL',
    paths: [join(home, 'global'), join(home, 'projects'), join(home, 'agents')].filter(p => pathExists(p)),
    inboxEdits: [],
  };
}

/** True when the plan would delete nothing. */
export function planIsEmpty(plan: PurgePlan): boolean {
  return plan.paths.length === 0 && plan.inboxEdits.length === 0;
}

/** Number of inbox entries a plan removes. */
export function plannedEntries(plan: PurgePlan): number {
  return plan.inboxEdits.reduce((sum, edit) => sum + edit.ids.length, 0);
}

/**
 * The disclosure A19 requires, in the command's own output rather than only the docs.
 *
 * mehmory cannot honestly claim the content is gone: the store is a git repository and
 * every purged file is still reachable in its history. Vendoring or shelling out to
 * `filter-repo` was rejected (tool dependency with no fail-open answer), so the recipe
 * is printed and the user runs it.
 */
export function historyNotice(plan: PurgePlan): readonly string[] {
  const home = mehmoryHome();
  // A `--session` purge removes lines from inboxes rather than whole paths, so the
  // recipe names the inboxes — a recipe pointing at a file the purge never touched
  // would be worse than none.
  if (plan.form === 'session') {
    return [
      'note: purge deletes selected inbox entries from the working tree and commits the removal.',
      '      mehmory never rewrites your git history. Selective line history removal requires',
      '      a separate manual rewrite procedure; the whole inbox must not be removed.',
    ];
  }
  const paths = plan.paths
    .map(p => relative(home, p))
    .filter(p => p !== '');
  const recipe = `git -C ${shellQuote(home)} filter-repo ${paths.map(p => `--path ${shellQuote(p)}`).join(' ')} --invert-paths`;
  return [
    'note: purge deletes from the working tree and commits the removal. mehmory never',
    '      rewrites your git history, so the content remains reachable there. To remove',
    '      it from history too, run:',
    `      ${recipe}`,
  ];
}

// ─── Execution ───

export type PurgeOutcome =
  | { readonly ok: true; readonly removed: number; readonly entries: number }
  | { readonly ok: false; readonly error: MehmoryError; readonly deleted: boolean };

/** Quote one value for a POSIX shell command shown to a user. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isSafeStoreTarget(path: string, home: string): boolean {
  try {
    if (lstat(path)?.isSymbolicLink()) return false;
    const suffix = relative(realpath(home), realpath(path));
    return suffix === '' || (suffix !== '..' && !suffix.startsWith('..' + sep));
  } catch {
    return false;
  }
}

function assertNoSymlinkComponents(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstat(current)?.isSymbolicLink()) throw new Error(`refusing symlink export component ${current}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('refusing symlink')) throw err;
    }
    const parent = resolve(current, '..');
    if (parent === current) return;
    current = parent;
  }
}

function copyTree(from: string, to: string): void {
  assertNoSymlinkComponents(to);
  if (lstat(from)?.isSymbolicLink()) throw new Error(`refusing symlink export source ${from}`);
  if (stat(from)?.isDirectory() === true) {
    mkdir(to);
    for (const name of listDir(from)) copyTree(join(from, name), join(to, name));
    return;
  }
  atomicWrite(to, readFileFromNoFollow(from, 0));
}

/**
 * Copy every target under `dest`, preserving its path relative to the store.
 *
 * Runs before anything is deleted and aborts the whole purge on failure (exit 3): an
 * export the user asked for and did not get is the one failure mode where continuing
 * destroys the only copy.
 */
function exportTargets(plan: PurgePlan, dest: string): void {
  assertNoSymlinkComponents(dest);
  const home = mehmoryHome();
  for (const path of plan.paths) {
    copyTree(path, join(dest, relative(home, path)));
  }
  for (const edit of plan.inboxEdits) {
    const output = join(dest, relative(home, edit.inboxFile));
    assertNoSymlinkComponents(output);
    const doomed = new Set(edit.ids);
    const lines = readFile(edit.inboxFile)
      .split('\n')
      .filter(line => parseInboxEntries(line).some(entry => doomed.has(entry.id)));
    atomicWrite(
      output,
      lines.length > 0 ? lines.join('\n') + '\n' : ''
    );
  }
}

/**
 * Remove now-empty parents up to (but never including) `stop`.
 *
 * Nested keys such as `github.com/acme/widgets` otherwise leave `github.com/acme`
 * behind, which `listProjects()` walks on every scope resolution forever after.
 */
function pruneEmptyParents(dir: string, stop: string): void {
  let current = dir;
  for (;;) {
    const parent = join(current, '..');
    if (parent === current || relative(stop, parent) === '' || relative(stop, parent).startsWith('..')) {
      return;
    }
    if (!pathExists(parent) || listDir(parent).length > 0) return;
    removeDir(parent);
    current = parent;
  }
}

/**
 * Export (if asked), delete, prune, commit.
 *
 * The order is the contract: a failed export changes nothing, while a failed **commit**
 * happens after the files are already gone — so that terminal state is reported as a
 * dirty store with a runnable remedy rather than as a rollback that cannot happen.
 */
export function executePurge(plan: PurgePlan, exportTo: string | undefined): PurgeOutcome {
  return (
    withProjectLock('__store__', () => executePurgeUnlocked(plan, exportTo), 50, 100, false) ?? {
      ok: false,
      deleted: false,
      error: {
        code: 'E_LOCK_TIMEOUT',
        kind: 'informational',
        what: 'the memory store is busy with another write',
        consequence: 'Nothing was deleted; retry the purge',
      },
    }
  );
}

function executePurgeUnlocked(plan: PurgePlan, exportTo: string | undefined): PurgeOutcome {
  const home = mehmoryHome();

  if (exportTo !== undefined) {
    const destination = resolve(exportTo);
    const overlapTargets = [...plan.paths, ...plan.inboxEdits.map(edit => edit.inboxFile)];
    const overlaps = overlapTargets.some(path => {
      const target = resolve(path);
      const destinationInsideTarget = relative(target, destination);
      const targetInsideDestination = relative(destination, target);
      return (
        destinationInsideTarget === '' ||
        !destinationInsideTarget.startsWith('..') ||
        targetInsideDestination === '' ||
        !targetInsideDestination.startsWith('..')
      );
    });
    if (overlaps) {
      return {
        ok: false,
        deleted: false,
        error: {
          code: 'E_PURGE_FAILED',
          kind: 'actionable',
          what: `export destination ${exportTo} overlaps a purge target`,
          consequence: 'Nothing was deleted',
          fix: 'choose an export directory outside the memory store',
        },
      };
    }
    try {
      exportTargets(plan, exportTo);
    } catch (err) {
      return {
        ok: false,
        deleted: false,
        error: {
          code: 'E_PURGE_FAILED',
          kind: 'actionable',
          what: `export to ${exportTo} failed: ${err instanceof Error ? err.message : String(err)}`,
          consequence: 'Nothing was deleted',
          fix: `mkdir -p ${shellQuote(exportTo)}`,
        },
      };
    }
  }

  const commitTargets = [
    ...plan.paths.map(path => `:(top,literal)${relative(home, path)}`),
    ...plan.inboxEdits.map(edit => `:(top,literal)${relative(home, edit.inboxFile)}`),
  ].filter(path => path !== '');

  const baseline = ensureGitBaseline(home);
  if (!baseline.ok) {
    return {
      ok: false,
      deleted: false,
      error: {
        code: 'E_PURGE_FAILED',
        kind: 'actionable',
        what: `the memory store has no usable git baseline at ${home}`,
        consequence: 'Nothing was deleted',
        fix: `git -C ${shellQuote(home)} status`,
      },
    };
  }

  let removed = 0;
  try {
    for (const path of plan.paths) {
      if (!pathExists(path)) continue;
      if (!isSafeStoreTarget(path, home)) throw new Error(`refusing unsafe purge target ${path}`);
      if (stat(path)?.isDirectory() === true) {
        removeDir(path);
        pruneEmptyParents(path, join(home, 'projects'));
      } else {
        remove(path);
      }
      removed++;
    }
  } catch (err) {
    return {
      ok: false,
      deleted: removed > 0,
      error: {
        code: 'E_PURGE_FAILED',
        kind: 'actionable',
        what: err instanceof Error ? err.message : String(err),
        consequence: `${String(removed)} of ${String(plan.paths.length)} targets were deleted before the failure`,
        fix: `git -C ${shellQuote(home)} status`,
      },
    };
  }

  let entries = 0;
  for (const edit of plan.inboxEdits) {
    const cleared = clearInboxEntries(edit.inboxFile, edit.key, edit.ids);
    if (cleared === undefined) {
      return {
        ok: false,
        deleted: removed > 0 || entries > 0,
        error: {
          code: 'E_LOCK_TIMEOUT',
          kind: 'informational',
          what: `could not lock inbox ${edit.inboxFile}`,
          consequence: 'The selected inbox entries remain; retry the purge',
        },
      };
    }
    entries += cleared.removed;
  }

  if (removed === 0 && entries === 0) return { ok: true, removed, entries };

  const committed = commitPaths(
    [...new Set(commitTargets)],
    `purge: ${plan.label}`,
    home,
    true
  );
  if (!committed.ok) {
    // The files are already gone; there is no rollback. Say exactly that, and give the
    // command that finishes the job (criterion 11).
    return {
      ok: false,
      deleted: true,
      error: {
        code: 'E_PURGE_FAILED',
        kind: 'actionable',
        what: `the deletion could not be committed to ${home}`,
        consequence: 'The content is deleted but the store is left dirty',
        fix: `git -C ${shellQuote(home)} commit -a -m purge`,
      },
    };
  }

  return { ok: true, removed, entries };
}
