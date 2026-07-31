/**
 * Environment probes shared by `mehmory init` and `mehmory doctor`.
 *
 * Both commands ask the same two questions — is this Node new enough, and is the plugin
 * actually installed — so the answers live here once (A17: the CLI formats, it does not
 * decide). Neither probe throws (A11); an unreadable or absent file is "not installed".
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathExists, readFile } from './fs.js';
import { failOpen } from './errors.js';

/** Claude Code hook events this plugin registers, keyed by their `config.hooks` name. */
export const HOOK_EVENTS = {
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  stop: 'Stop',
  pre_compact: 'PreCompact',
  session_end: 'SessionEnd',
} as const;

export type HookConfigKey = keyof typeof HOOK_EVENTS;

/**
 * The pinned install commands, printed verbatim when the plugin is absent.
 *
 * They are slash commands, so every caller prefixes them with "in a Claude Code session,
 * run …" (U13): `mehmory init` runs in a shell, where typing them does nothing.
 */
export const PLUGIN_INSTALL_COMMANDS: readonly string[] = [
  '/plugin marketplace add elderfo/mehmory',
  '/plugin install mehmory@mehmory',
];

/** Result of the plugin filesystem probe. */
export interface PluginProbe {
  /** True only when a `hooks.json` was found on disk — not merely a manifest entry. */
  readonly installed: boolean;
  /** Directory the plugin was found in. */
  readonly installPath?: string;
  /** Claude Code events the installed `hooks.json` actually registers. */
  readonly registeredEvents: readonly string[];
}

/** `~/.claude`, honoring `HOME` so a test can point it at a temp directory. */
function claudeHome(): string {
  return join(homedir(), '.claude');
}

/**
 * Locate the installed plugin and read back which hook events it registers.
 *
 * Deliberately a filesystem probe rather than a manifest read (spec gap 14): Claude
 * Code's `installed_plugins.json` records an `installPath` that a failed or removed
 * install can leave behind, and a registry entry pointing at a directory with no
 * `hooks/hooks.json` means no hook will ever fire. The file is what has to be there.
 */
export function probePlugin(): PluginProbe {
  return failOpen(
    () => {
      const registry = join(claudeHome(), 'plugins', 'installed_plugins.json');
      if (!pathExists(registry)) return NOT_INSTALLED;

      const parsed: unknown = JSON.parse(readFile(registry));
      if (typeof parsed !== 'object' || parsed === null) return NOT_INSTALLED;
      const plugins = (parsed as Record<string, unknown>)['plugins'];
      if (typeof plugins !== 'object' || plugins === null) return NOT_INSTALLED;

      for (const [id, entries] of Object.entries(plugins as Record<string, unknown>)) {
        if (id !== 'mehmory' && !id.startsWith('mehmory@')) continue;
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as readonly unknown[]) {
          if (typeof entry !== 'object' || entry === null) continue;
          const installPath = (entry as Record<string, unknown>)['installPath'];
          if (typeof installPath !== 'string') continue;
          const hooksFile = join(installPath, 'hooks', 'hooks.json');
          if (!pathExists(hooksFile)) continue;
          return {
            installed: true,
            installPath,
            registeredEvents: readRegisteredEvents(hooksFile),
          };
        }
      }
      return NOT_INSTALLED;
    },
    NOT_INSTALLED,
    'E_SEARCH_FAILED'
  );
}

const NOT_INSTALLED: PluginProbe = { installed: false, registeredEvents: [] };

/** Event names a `hooks.json` registers. Empty when it is unreadable or malformed. */
function readRegisteredEvents(hooksFile: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readFile(hooksFile));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const hooks = (parsed as Record<string, unknown>)['hooks'];
    if (typeof hooks !== 'object' || hooks === null) return [];
    return Object.keys(hooks);
  } catch {
    return [];
  }
}

/** Outcome of comparing the running Node against `package.json` `engines.node`. */
export interface NodeCheck {
  readonly ok: boolean;
  /** The running version, e.g. `v22.22.3`. */
  readonly current: string;
  /** The `engines.node` range as written, e.g. `>=22`. */
  readonly required: string;
}

/**
 * Compare the running Node version against an `engines.node` range.
 *
 * Only the minimum is read (`>=22`, `22.5.0`, `^22`) — that is the whole shape this
 * project's `engines` uses, and a full semver-range implementation would be a
 * dependency for one comparison.
 */
export function checkNodeVersion(required: string, current: string = process.version): NodeCheck {
  const wanted = parseVersion(required);
  const running = parseVersion(current);
  if (wanted === undefined || running === undefined) {
    // An unreadable range must not fail a healthy install.
    return { ok: true, current, required };
  }
  for (let i = 0; i < 3; i++) {
    const a = running[i] ?? 0;
    const b = wanted[i] ?? 0;
    if (a !== b) return { ok: a > b, current, required };
  }
  return { ok: true, current, required };
}

/** First `major[.minor[.patch]]` in a string, as a numeric triple. */
function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return undefined;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}
