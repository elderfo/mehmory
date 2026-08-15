/**
 * One scope grammar for every scope-taking command (criterion 12).
 *
 * `src/core/scopes.ts` returns data — `match | ambiguous | none` — because A11 keeps
 * `process.exit` out of core. Turning those into exit codes is this file's whole job,
 * so `search`, `stats`, `onboard` and `purge` cannot drift apart on what `--project`
 * means or on what an ambiguous selector costs.
 */

import { join } from 'node:path';
import { resolveAgentName } from '../core/agent.js';
import { mehmoryHome } from '../core/home.js';
import { resolveProjectKey } from '../core/identity.js';
import { AGENT_SCOPE_PREFIX, resolveAgentScope, resolveScope } from '../core/scopes.js';
import type { MehmoryConfig } from '../core/config.js';
import type { FlagSpec, FlagValue } from './args.js';
import { usageError, type CommandResult } from './command.js';

/** The four scope flags, in the shape `parseFlags` wants. Spread into a command's spec. */
export const SCOPE_FLAGS: FlagSpec = {
  project: 'optional',
  global: 'boolean',
  all: 'boolean',
  agent: 'optional',
};

/** The resolved scope a command acts on. */
export type ScopeSelection =
  | { readonly kind: 'project'; readonly key: string; readonly dir: string }
  | { readonly kind: 'global'; readonly dir: string }
  | { readonly kind: 'agent'; readonly name: string; readonly dir: string }
  | { readonly kind: 'all' };

export type ScopeOutcome =
  | { readonly ok: true; readonly scope: ScopeSelection }
  | { readonly ok: false; readonly result: CommandResult };

/**
 * Map `--project [<key>] | --global | --agent [<name>] | --all` onto a scope.
 *
 * No flag at all means the current directory's project, which is the same thing bare
 * `--project` means. Ambiguity is exit 1 listing the candidates, never a guess.
 *
 * `--agent` is a separate flag rather than a differently-shaped value for `--project`
 * because the *flag* is what separates the namespaces (KTD4): `--project` resolves only
 * against `listProjects()` and `--agent` only against `listAgentScopes()`, so the
 * substring pass in `resolveScope` can never wander into an agent's self.
 */
export function selectScope(
  flags: ReadonlyMap<string, FlagValue>,
  cwd: string,
  config: MehmoryConfig
): ScopeOutcome {
  const named = (['project', 'global', 'all', 'agent'] as const).filter(name => flags.has(name));
  if (named.length > 1) {
    return {
      ok: false,
      result: usageError(
        `\`--${named.join('` and `--')}\` cannot be combined`,
        'mehmory --help'
      ),
    };
  }

  if (flags.has('all')) return { ok: true, scope: { kind: 'all' } };
  if (flags.has('global')) {
    return { ok: true, scope: { kind: 'global', dir: join(mehmoryHome(), 'global') } };
  }

  if (flags.has('agent')) return selectAgent(flags.get('agent'), config);

  const selector = flags.get('project');
  if (typeof selector === 'string') {
    const resolution = resolveScope(selector, config);
    if (resolution.kind === 'ambiguous') {
      return {
        ok: false,
        result: usageError(
          `\`${selector}\` matches ${String(resolution.candidates.length)} projects: ${resolution.candidates.join(', ')}`,
          `mehmory --project ${resolution.candidates[0] ?? selector}`
        ),
      };
    }
    if (resolution.kind === 'none') {
      return {
        ok: false,
        result: usageError(`no project matches \`${selector}\``, 'mehmory status'),
      };
    }
    return {
      ok: true,
      scope: { kind: 'project', key: resolution.project.key, dir: resolution.project.dir },
    };
  }

  // Bare `--project`, or no scope flag: the current directory's resolved key. The
  // project may have no directory yet (nothing has been captured for it), which is not
  // an error — the key is still the right answer.
  const key = resolveProjectKey(cwd);
  const resolution = resolveScope(key, config);
  const dir =
    resolution.kind === 'match' ? resolution.project.dir : join(mehmoryHome(), 'projects', key);
  return { ok: true, scope: { kind: 'project', key, dir } };
}

/**
 * `--agent [<name>]`: an exact name, or bare, meaning the agent running this session.
 *
 * Bare with no name resolvable is a usage error rather than a silent fall-through to the
 * project scope — an unnamed agent has no self to address, and quietly answering about
 * something else is worse than saying so.
 */
function selectAgent(selector: FlagValue | undefined, config: MehmoryConfig): ScopeOutcome {
  const typed = typeof selector === 'string' ? selector.trim() : '';
  const name =
    typed === ''
      ? resolveAgentName(process.env['MEHMORY_AGENT'], config.identity.agent)
      : typed;
  if (name === undefined) {
    return {
      ok: false,
      result: usageError(
        'bare `--agent` needs a named agent: neither MEHMORY_AGENT nor `identity.agent` is set',
        'mehmory --agent <name>'
      ),
    };
  }

  const agent = resolveAgentScope(name);
  if (agent === undefined) {
    // Never created on demand: an agent scope appears when integration routes a fact
    // into it, and a typo must not mint an empty self.
    return {
      ok: false,
      result: usageError(`no agent scope matches \`${name}\``, 'mehmory status'),
    };
  }
  return { ok: true, scope: { kind: 'agent', name: agent.name, dir: agent.dir } };
}

/** Human label for a scope, used in output and in the `scope` field of `--json` data. */
export function scopeLabel(scope: ScopeSelection): string {
  switch (scope.kind) {
    case 'project':
      return scope.key;
    case 'global':
      return 'global';
    case 'agent':
      return AGENT_SCOPE_PREFIX + scope.name;
    case 'all':
      return 'all';
  }
}
