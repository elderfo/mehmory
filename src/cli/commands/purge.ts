/**
 * `mehmory purge` — criterion 11. **Stub: unit C2 owns the body.**
 *
 * Registered here so the registry in `src/cli/index.ts` is complete and `--help` is
 * already correct. Replacing this file with the real command touches nothing else.
 */

import { parseFlags } from '../args.js';
import { usageError, type Command } from '../command.js';
import { SCOPE_FLAGS } from '../scope.js';

export const command: Command = {
  name: 'purge',
  summary: 'delete memory from the working tree and commit the removal',
  usage:
    'mehmory purge <page-slug> | --session <id> | --project [<key>] | --global | --all [--dry-run] [--export <path>] [--yes]',
  help: [
    '  <page-slug>       one page; ambiguous across scopes exits 1 listing candidates',
    '  --session <id>    un-integrated inbox entries captured by that session',
    '  --project [<key>] one project; bare means the current directory',
    '  --global          identity.md and global/pages/',
    '  --all             everything in the store',
    '  --dry-run         preview the targets; deletes nothing',
    '  --export <path>   copy the targets there first; aborts if the copy fails',
    '  --yes             skip the typed confirmation',
    '  --json            emit the single-line JSON envelope instead of text',
    '',
    '  Purge deletes from the working tree and never rewrites git history.',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, {
      ...SCOPE_FLAGS,
      session: 'value',
      'dry-run': 'boolean',
      export: 'value',
      yes: 'boolean',
    });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory purge --help');
    return usageError('`mehmory purge` is not implemented yet', 'mehmory purge --help');
  },
};
