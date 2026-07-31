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
