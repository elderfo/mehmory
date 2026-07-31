/**
 * `mehmory search` — criterion 6. **Stub: unit S owns the body.**
 *
 * Registered here so the registry in `src/cli/index.ts` is complete and `--help` is
 * already correct. Replacing this file with the real command touches nothing else.
 */

import { parseFlags } from '../args.js';
import { usageError, type Command } from '../command.js';
import { SCOPE_FLAGS } from '../scope.js';

export const command: Command = {
  name: 'search',
  summary: 'rank hits across the pages, archive and log of the selected scopes',
  usage: 'mehmory search <query> [--project [<key>]|--global|--all] [--limit N] [--json]',
  help: [
    '  <query>           text to search for',
    '  --project [<key>] one project; bare means the current directory (default)',
    '  --global          the global scope',
    '  --all             every scope in the store',
    '  --limit N         maximum hits to return (default 10, capped at 100)',
    '  --json            emit the single-line JSON envelope instead of text',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, { ...SCOPE_FLAGS, limit: 'value' });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory search --help');
    return usageError('`mehmory search` is not implemented yet', 'mehmory search --help');
  },
};
