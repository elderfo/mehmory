/**
 * Project discovery and selector resolution — the one grammar `search`, `stats`,
 * `purge` and `onboard` share (plan criterion 12).
 *
 * Returns data, never exit codes: A11 keeps `src/core/` free of `process.exit`, so the
 * CLI is what turns an `ambiguous` result into exit 1 with a candidate list.
 */

import { join, sep } from 'node:path';
import { mehmoryHome } from './home.js';
import { listDir, pathExists, stat } from './fs.js';
import { failOpen } from './errors.js';
import { isSafeAgentName } from './agent.js';
import { loadConfig, type MehmoryConfig } from './config.js';

/**
 * Project keys are 2–5 path segments (`github.com/owner/repo`, `local/<hash12>`,
 * `remote/<hash12>` — see `identity.ts`), so a flat `listDir` of `projects/` returns
 * hostnames, not projects. This is how deep the walk goes.
 */
const MAX_KEY_SEGMENTS = 5;

/** One discovered project. */
export interface ProjectScope {
  /** Store key, `/`-joined regardless of platform separator (`github.com/owner/repo`). */
  readonly key: string;
  /** Absolute path of `<home>/projects/<key>`. */
  readonly dir: string;
}

/** Outcome of resolving a user-supplied scope selector. */
export type ScopeResolution =
  /** Exactly one project matched. */
  | { readonly kind: 'match'; readonly project: ProjectScope }
  /** The selector is a substring of more than one key. The CLI exits 1 listing these. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  /** Nothing matched. */
  | { readonly kind: 'none' };

/**
 * Every project in the store, sorted by key.
 *
 * A project is any directory under `projects/` that contains `inbox.md` — the file
 * every capture path creates — walked to `MAX_KEY_SEGMENTS` deep. Never throws (A2/A11):
 * an unreadable store yields an empty list plus an `errors.log` entry.
 */
export function listProjects(): readonly ProjectScope[] {
  return failOpen(
    () => {
      const root = join(mehmoryHome(), 'projects');
      if (!pathExists(root)) return [];

      const found: ProjectScope[] = [];
      const walk = (dir: string, segments: readonly string[]): void => {
        for (const name of listDir(dir)) {
          const child = join(dir, name);
          if (!pathExists(child) || !stat(child)?.isDirectory()) continue;

          const path = [...segments, name];
          if (pathExists(join(child, 'inbox.md'))) {
            found.push({ key: path.join('/'), dir: child });
          }
          if (path.length < MAX_KEY_SEGMENTS) walk(child, path);
        }
      };
      walk(root, []);

      return found.sort((a, b) => a.key.localeCompare(b.key));
    },
    [],
    'E_SEARCH_FAILED'
  );
}

/**
 * Scope-label prefix for an agent scope (`agent:scout`).
 *
 * Agent names and project keys live in separate namespaces (KTD4), and a scope *label*
 * is where the two would otherwise meet: `findPages` and `search --all` mix them in one
 * list. The prefix keeps a name from ever reading as a key, and is what `--agent` in a
 * suggested fix is derived from.
 */
export const AGENT_SCOPE_PREFIX = 'agent:';

/** One discovered agent scope (R2). */
export interface AgentScope {
  /** The agent's name, which is its single directory segment under `agents/`. */
  readonly name: string;
  /** Absolute path of `<home>/agents/<name>`. */
  readonly dir: string;
}

/**
 * Every agent scope in the store, sorted by name.
 *
 * `listProjects` counts a directory as a scope when it holds `inbox.md`, but an agent
 * scope never has one — capture always writes the project inbox (R6) — so this keys on
 * `identity.md` instead: the page that says what the agent is. One level deep, because
 * an agent name is a single segment (`isSafeAgentName`) and anything below it is
 * content inside a scope, not a scope. Never throws (A2/A11), like `listProjects`.
 */
export function listAgentScopes(): readonly AgentScope[] {
  return failOpen(
    () => {
      const root = join(mehmoryHome(), 'agents');
      if (!pathExists(root)) return [];

      const found: AgentScope[] = [];
      for (const name of listDir(root)) {
        const dir = join(root, name);
        // `pathExists` first: `stat` is `statSync`, which throws on a dangling symlink or
        // a permission-denied entry rather than returning undefined, and the whole loop
        // runs inside `failOpen` — so one bad entry would collapse the entire listing to
        // empty instead of being skipped. `listProjects` guards the same call for the same
        // reason.
        if (!pathExists(dir) || !stat(dir)?.isDirectory()) continue;
        if (!pathExists(join(dir, 'identity.md'))) continue;
        // A directory whose name is not a safe agent name was not created by mehmory
        // and can never be addressed: `agentScopePaths` throws on it, so listing it
        // would only hand callers a name that detonates on use.
        if (!isSafeAgentName(name)) continue;
        found.push({ name, dir });
      }

      return found.sort((a, b) => a.name.localeCompare(b.name));
    },
    [],
    'E_SEARCH_FAILED'
  );
}

/**
 * Resolve a selector — a full key or a unique substring of one — to a project.
 *
 * `config.identity.aliases` maps a *source* key to the *target* it is stored under
 * (`identity.ts`), so only targets ever exist on disk. Sources are resolved to their
 * targets here, which is what makes A5's alias map an actual escape hatch for splits
 * and merges: a user who aliased a key can still name it.
 *
 * @param selector — full key or substring
 * @param config — threaded, not loaded ambiently (criterion 13)
 */
export function resolveScope(
  selector: string,
  config: MehmoryConfig = loadConfig()
): ScopeResolution {
  const projects = listProjects();
  const byKey = new Map(projects.map(p => [p.key, p]));

  /** Every name a user may type → the project it denotes. */
  const names = new Map<string, ProjectScope>(byKey);
  for (const [source, target] of Object.entries(config.identity.aliases)) {
    const project = byKey.get(target);
    // An alias whose target has no directory yet names nothing; leaving it out keeps
    // `none` and `ambiguous` honest.
    if (project && !names.has(source)) names.set(source, project);
  }

  const needle = selector.trim().split(sep).join('/');
  if (needle === '') return { kind: 'none' };

  const exact = names.get(needle);
  if (exact) return { kind: 'match', project: exact };

  const matched = new Map<string, ProjectScope>();
  for (const [name, project] of names) {
    if (name.includes(needle)) matched.set(project.key, project);
  }

  const candidates = [...matched.values()];
  if (candidates.length === 1 && candidates[0]) {
    return { kind: 'match', project: candidates[0] };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidates: candidates.map(p => p.key).sort() };
  }
  return { kind: 'none' };
}

/**
 * Resolve an agent name to its scope, or `undefined` when nothing matches (KTD4).
 *
 * Exact only, and only over `listAgentScopes()`. Two deliberate differences from
 * `resolveScope`: there is no substring pass, because an agent name is a single
 * segment and a near miss would silently address a different agent's self; and
 * `config.identity.aliases` is never consulted, because that table maps *project*
 * keys and an alias pointing at an agent name would cross the namespaces the flag
 * exists to keep apart.
 */
export function resolveAgentScope(name: string): AgentScope | undefined {
  return listAgentScopes().find(agent => agent.name === name);
}
