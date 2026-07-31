/**
 * `mehmory init` — criterion 4.
 *
 * Idempotent, because `initStore()` is (A6). This command adds no layout of its own:
 * `.gitignore` and the empty `config.json` are `initStore()`'s, and writing them again
 * here would be a second owner of the same files.
 */

import { initStore } from '../../core/store.js';
import { PLUGIN_INSTALL_COMMANDS, checkNodeVersion, probePlugin } from '../../core/environment.js';
import { parseFlags } from '../args.js';
import { EXIT, operationFailed, usageError, type Command } from '../command.js';
import { REQUIRED_NODE } from '../package-info.js';

export const command: Command = {
  name: 'init',
  summary: 'create the store, then report the Node and plugin setup around it',
  usage: 'mehmory init [--json]',
  help: ['  --json            emit the single-line JSON envelope instead of text'],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, {});
    if (!parsed.ok) return usageError(parsed.what, 'mehmory init --help');
    if (parsed.positional.length > 0) {
      return usageError(
        `\`init\` takes no arguments (got \`${parsed.positional[0] ?? ''}\`)`,
        'mehmory init'
      );
    }

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
  },
};
