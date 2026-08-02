/**
 * `mehmory init` — criterion 4, plus the Codex host install (issue #21).
 *
 * Idempotent, because `initStore()` is (A6). This command adds no layout of its own:
 * `.gitignore` and the empty `config.json` are `initStore()`'s, and writing them again
 * here would be a second owner of the same files.
 *
 * `--host` selects which harness to wire up. The default harness installs through
 * Claude Code's plugin system, so there is nothing for `init` to write and it only
 * reports; Codex has no plugin path for hooks, so `init` writes the configuration
 * itself — see `src/core/codex-install.ts` for why that is a merge and not a rewrite.
 */

import { initStore } from '../../core/store.js';
import { PLUGIN_INSTALL_COMMANDS, checkNodeVersion, probePlugin } from '../../core/environment.js';
import { installCodex, uninstallCodex, type CodexResult } from '../../core/codex-install.js';
import { DEFAULT_INBOX_HOST, INBOX_HOSTS, type InboxHost } from '../../schema/format.js';
import { flagString, parseFlags } from '../args.js';
import { EXIT, operationFailed, usageError, type Command, type CommandResult } from '../command.js';
import { REQUIRED_NODE } from '../package-info.js';

export const command: Command = {
  name: 'init',
  summary: 'create the store, then report the Node and plugin setup around it',
  usage: 'mehmory init [--host <name>] [--uninstall] [--json]',
  help: [
    `  --host <name>     harness to wire up: ${INBOX_HOSTS.join(' | ')} (default ${DEFAULT_INBOX_HOST})`,
    '  --uninstall       remove the harness wiring again; requires a non-default --host',
    '  --json            emit the single-line JSON envelope instead of text',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, { host: 'value', uninstall: 'boolean' });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory init --help');
    if (parsed.positional.length > 0) {
      return usageError(
        `\`init\` takes no arguments (got \`${parsed.positional[0] ?? ''}\`)`,
        'mehmory init'
      );
    }

    const requested = flagString(parsed.flags, 'host') ?? DEFAULT_INBOX_HOST;
    if (!isKnownHost(requested)) {
      return usageError(
        `unknown host \`${requested}\` (try one of: ${INBOX_HOSTS.join(', ')})`,
        'mehmory init --help'
      );
    }
    const uninstall = parsed.flags.get('uninstall') === true;

    if (requested === 'codex') {
      return hostResult(uninstall ? uninstallCodex() : installCodex(requested), requested, uninstall);
    }
    if (uninstall) {
      // Claude Code owns its own install, so there is nothing here to reverse. Say so
      // rather than exiting 0 on a no-op the user will read as "done".
      return usageError(
        '`--uninstall` has no meaning for the default host — Claude Code installs and removes mehmory through its plugin system',
        'in a Claude Code session, run `/plugin uninstall mehmory@mehmory`'
      );
    }

    return initDefaultHost();
  },
};

function isKnownHost(value: string): value is InboxHost {
  return (INBOX_HOSTS as readonly string[]).includes(value);
}

/** The original `init`: create the store, then report the environment around it. */
function initDefaultHost(): CommandResult {
  const created = initStore();
  if (!created.ok) return operationFailed(created.error);

  const node = checkNodeVersion(REQUIRED_NODE);
  const plugin = probePlugin();

  const lines = [
    `store ready at ${created.home}`,
    `node ${node.current} (requires ${node.required})`,
    plugin.installed
      ? `plugin installed at ${plugin.installPath ?? '(unknown)'}`
      : 'plugin not installed',
  ];
  const warnings: string[] = [];

  if (!node.ok) {
    warnings.push(
      `node ${node.current} is below the required ${node.required}; the hooks may not run`
    );
  }
  if (!plugin.installed) {
    // Slash commands do nothing in the shell `init` runs in, so say where to type
    // them (U13). Pinned commands, not a prose pointer at the docs.
    warnings.push(
      `the plugin is not installed — in a Claude Code session, run \`${PLUGIN_INSTALL_COMMANDS.join('` then `')}\``
    );
  }

  // The next step, always last and always explicit about where it is typed. Note the
  // order: `onboard` seeds the inbox from existing transcripts, and only the integrate
  // that follows puts anything where a session can read it.
  lines.push('next: mehmory onboard');
  lines.push('then: in a Claude Code session, run `/mehmory:integrate`');

  return {
    exit: EXIT.OK,
    lines,
    warnings,
    data: {
      home: created.home,
      node: { current: node.current, required: node.required, ok: node.ok },
      plugin: {
        installed: plugin.installed,
        ...(plugin.installPath !== undefined ? { installPath: plugin.installPath } : {}),
      },
      next: ['mehmory onboard', '/mehmory:integrate'],
    },
  };
}

/** Render an install or uninstall of the Codex wiring. */
function hostResult(result: CodexResult, host: InboxHost, uninstall: boolean): CommandResult {
  if (!result.ok) return operationFailed(result.error);
  const { report } = result;

  const lines = uninstall
    ? [
        report.changed.length === 0
          ? `no mehmory entries in ${report.hooksFile}`
          : `mehmory entries removed from ${report.hooksFile}`,
        // Never turned off: the flag is Codex's, and other tools' hooks depend on it.
        `Codex \`[features] hooks\` left as it is in ${report.configFile}`,
        'skills removed',
      ]
    : [
        report.changed.length === 0
          ? `already wired into ${report.hooksFile}`
          : `mehmory wired into ${report.hooksFile}`,
        `hooks: ${report.events.join(', ')}`,
        report.featureFlag === 'already-on'
          ? 'Codex `[features] hooks` already on'
          : 'Codex `[features] hooks` enabled',
        `skills: ${report.skills.join(', ')}`,
      ];

  for (const path of report.backups) lines.push(`backed up to ${path}`);
  lines.push('next: mehmory doctor');

  return {
    exit: EXIT.OK,
    lines,
    data: {
      host,
      action: uninstall ? 'uninstall' : 'install',
      hooksFile: report.hooksFile,
      configFile: report.configFile,
      events: report.events,
      changed: report.changed,
      backups: report.backups,
      featureFlag: report.featureFlag,
      skills: report.skills,
    },
  };
}
