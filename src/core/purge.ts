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

import { join, relative } from 'node:path';
import { atomicWrite, listDir, mkdir, pathExists, readFile, remove, removeDir, stat } from './fs.js';
import { mehmoryHome, statePath } from './home.js';
import { commitPaths } from './git.js';
import { clearInboxEntries, readInboxEntries } from './inbox.js';
import { AGENT_SCOPE_PREFIX, listAgentScopes, listProjects } from './scopes.js';
import type { MehmoryError } from './errors.js';
import type { InboxEntry } from '../schema/format.js';

/** The six things a user can delete, in ascending blast radius. */
export type PurgeForm = 'page' | 'session' | 'global' | 'agent' | 'project' | 'all';

/** Inbox entries a stamp-keyed purge removes, grouped by the inbox holding them. */
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
  /** Queued distill jobs to rewrite or drop. Only `--agent` populates this today. */
  readonly queueEdits?: readonly QueueEdit[];
}

/** A bare page slug that exists in more than one scope. Never deleted from both. */
export interface PageCandidates {
  readonly slug: string;
  /** Scope labels holding a page with that slug, sorted. */
  readonly scopes: readonly string[];
}

/** Where a page with a given slug lives. */
export function findPages(slug: string): readonly { scope: string; path: string }[] {
  const home = mehmoryHome();
  const found: { scope: string; path: string }[] = [];
  const candidates: { scope: string; dir: string }[] = [
    { scope: 'global', dir: join(home, 'global', 'pages') },
    ...listProjects().map(p => ({ scope: p.key, dir: join(p.dir, 'pages') })),
    // An agent scope holds pages like any other, so a bare slug must reach it — the
    // prefix is what keeps its label from reading as a project key.
    ...listAgentScopes().map(a => ({ scope: AGENT_SCOPE_PREFIX + a.name, dir: join(a.dir, 'pages') })),
  ];
  for (const { scope, dir } of candidates) {
    const path = join(dir, `${slug}.md`);
    if (pathExists(path)) found.push({ scope, path });
  }
  return found.sort((a, b) => a.scope.localeCompare(b.scope));
}

/**
 * Every inbox in the store, with the key its lock uses.
 *
 * Deliberately *not* extended to agent scopes: capture always writes the project inbox
 * (KTD3/R6), so an agent scope has no inbox to enumerate. `--session` therefore leaves
 * agent scopes untouched, which is correct rather than a gap.
 */
function allInboxes(): readonly { inboxFile: string; key: string }[] {
  const home = mehmoryHome();
  return [
    { inboxFile: join(home, 'global', 'inbox.md'), key: 'global' },
    ...listProjects().map(p => ({ inboxFile: join(p.dir, 'inbox.md'), key: p.key })),
  ];
}

/**
 * Inbox edits clearing every entry a predicate matches, across every inbox in the store.
 *
 * Two purge forms delete by something stamped on an entry rather than by a path —
 * `--session` by `src=`, `--agent` by `agent=` — and both have to sweep store-wide,
 * because the stamp says nothing about which project the entry landed in.
 */
function inboxEditsMatching(match: (entry: InboxEntry) => boolean): InboxEdit[] {
  const edits: InboxEdit[] = [];
  for (const { inboxFile, key } of allInboxes()) {
    const ids = readInboxEntries(inboxFile).filter(match).map(entry => entry.id);
    if (ids.length > 0) edits.push({ inboxFile, key, ids });
  }
  return edits;
}

/** A queued `distill-final` job holding entries stamped with the purged agent. */
export interface QueueEdit {
  /** Absolute path of the job file. */
  readonly jobPath: string;
  /** Entries that survive; empty means the whole job goes. */
  readonly keep: readonly Record<string, unknown>[];
  /** How many entries the purge removes from this job. */
  readonly removed: number;
}

/**
 * Queued jobs carrying entries stamped with `name`.
 *
 * SessionEnd distills but defers the write: entries live in `.state/queue/*.json` until a
 * later SessionStart drains them back into an inbox. Sweeping only the inboxes would leave
 * those stamps behind, and `applyDistillJob` preserves `agent` when it drains — so the
 * next session would rebuild the scope the user just deleted. `--agent` claims to remove
 * every stamp that would rebuild the agent, and this is the other half of that claim.
 *
 * A job mixing two agents' entries is rewritten rather than deleted, so retiring one agent
 * never discards another's pending work.
 */
function queueEditsForAgent(name: string): QueueEdit[] {
  const edits: QueueEdit[] = [];
  for (const dir of [statePath('queue'), join(statePath('queue'), 'claimed')]) {
    if (!pathExists(dir)) continue;
    for (const file of listDir(dir)) {
      if (!file.endsWith('.json')) continue;
      const jobPath = join(dir, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFile(jobPath));
      } catch {
        continue; // malformed job; claimJob skips it too
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const raw = (parsed as Record<string, unknown>)['entries'];
      if (!Array.isArray(raw)) continue;
      const entries = raw.filter(
        (e): e is Record<string, unknown> => typeof e === 'object' && e !== null
      );
      const keep = entries.filter(e => e['agent'] !== name);
      if (keep.length === entries.length) continue;
      edits.push({ jobPath, keep, removed: entries.length - keep.length });
    }
  }
  return edits;
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
  const edits = inboxEditsMatching(entry => entry.src === sessionId);
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
 * The plan for `--agent [<name>]`: the scope directory **and** every stamp that would
 * rebuild it (KTD8).
 *
 * Removing `agents/<name>/` alone does not delete the agent. Every un-integrated entry
 * carrying `agent=<name>` survives in its project inbox, and the next integration
 * routes it straight back into a fresh scope — so the sweep is part of the deletion,
 * not a courtesy.
 */
export function planAgent(name: string, dir: string): PurgePlan {
  const edits = inboxEditsMatching(entry => entry.agent === name);
  const queueEdits = queueEditsForAgent(name);
  return {
    form: 'agent',
    queueEdits,
    label: `agent ${name}`,
    // The **resolved** name, exactly as `planProject` pins the resolved key: a bare
    // `--agent` types nothing at all, and an empty string must never confirm a delete.
    token: name,
    paths: pathExists(dir) ? [dir] : [],
    inboxEdits: edits,
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
    paths: [join(home, 'global'), join(home, 'projects'), join(home, 'agents')].filter(p =>
      pathExists(p)
    ),
    inboxEdits: [],
  };
}

/** True when the plan would delete nothing. */
export function planIsEmpty(plan: PurgePlan): boolean {
  return (
    plan.paths.length === 0 &&
    plan.inboxEdits.length === 0 &&
    (plan.queueEdits ?? []).length === 0
  );
}

/** Number of inbox entries a plan removes. */
export function plannedEntries(plan: PurgePlan): number {
  return (
    plan.inboxEdits.reduce((sum, edit) => sum + edit.ids.length, 0) +
    (plan.queueEdits ?? []).reduce((sum, edit) => sum + edit.removed, 0)
  );
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
  const paths = [...plan.paths, ...plan.inboxEdits.map(edit => edit.inboxFile)]
    .map(p => relative(home, p))
    .filter(p => p !== '');
  const recipe = `git -C ${home} filter-repo ${paths.map(p => `--path ${p}`).join(' ')} --invert-paths`;
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

function copyTree(from: string, to: string): void {
  if (stat(from)?.isDirectory() === true) {
    mkdir(to);
    for (const name of listDir(from)) copyTree(join(from, name), join(to, name));
    return;
  }
  atomicWrite(to, readFile(from));
}

/**
 * Copy every target under `dest`, preserving its path relative to the store.
 *
 * Runs before anything is deleted and aborts the whole purge on failure (exit 3): an
 * export the user asked for and did not get is the one failure mode where continuing
 * destroys the only copy.
 */
function exportTargets(plan: PurgePlan, dest: string): void {
  const home = mehmoryHome();
  for (const path of plan.paths) {
    copyTree(path, join(dest, relative(home, path)));
  }
  for (const edit of plan.inboxEdits) {
    const doomed = new Set(edit.ids);
    const lines = readInboxEntries(edit.inboxFile)
      .filter(entry => doomed.has(entry.id))
      .map(entry => entry.text);
    atomicWrite(join(dest, relative(home, edit.inboxFile)), lines.join('\n') + '\n');
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
  const home = mehmoryHome();

  if (exportTo !== undefined) {
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
          fix: `mkdir -p ${exportTo}`,
        },
      };
    }
  }

  let removed = 0;
  try {
    for (const path of plan.paths) {
      if (!pathExists(path)) continue;
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
        fix: `git -C ${home} status`,
      },
    };
  }

  let entries = 0;
  for (const edit of plan.inboxEdits) {
    entries += clearInboxEntries(edit.inboxFile, edit.key, edit.ids).removed;
  }

  // Queued jobs, after the inboxes: a job left behind would drain its stamped entries
  // back into an inbox we just swept and rebuild the scope.
  for (const edit of plan.queueEdits ?? []) {
    entries += edit.removed;
    if (edit.keep.length === 0) {
      remove(edit.jobPath);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(readFile(edit.jobPath));
      if (typeof parsed !== 'object' || parsed === null) continue;
      atomicWrite(
        edit.jobPath,
        JSON.stringify({ ...(parsed as Record<string, unknown>), entries: edit.keep }, null, 2)
      );
    } catch {
      // Unreadable now though it parsed at plan time: drop it rather than leave stamps.
      remove(edit.jobPath);
    }
  }

  if (removed === 0 && entries === 0) return { ok: true, removed, entries };

  const committed = commitPaths(['.'], `purge: ${plan.label}`, home);
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
        fix: `git -C ${home} commit -a -m "purge"`,
      },
    };
  }

  return { ok: true, removed, entries };
}
