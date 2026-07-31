/**
 * `mehmory onboard` — criterion 5. **Stub: unit C2 owns the body.**
 *
 * Registered here so the registry in `src/cli/index.ts` is complete and `--help` is
 * already correct. Replacing this file with the real command touches nothing else.
 */

import { parseFlags } from '../args.js';
import { usageError, type Command } from '../command.js';

export const command: Command = {
  name: 'onboard',
  summary: 'seed the inbox by distilling existing Claude Code transcripts',
  usage:
    'mehmory onboard [--project [<key>]|--global] [--dry-run] [--sessions N] [--max-bytes N] [--projects N] [--resume]',
  help: [
    '  --project [<key>] one project; bare means the current directory (default)',
    '  --global          distill cross-project preferences into the global inbox',
    '  --dry-run         preview what would be distilled; writes nothing',
    '  --sessions N      transcripts to distill, newest first (default 30)',
    '  --max-bytes N     distilled-output cap in bytes (default 512000)',
    '  --projects N      transcript directories to scan (default 50)',
    '  --resume          continue an interrupted run with the same scope',
    '  --json            emit the single-line JSON envelope instead of text',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, {
      project: 'optional',
      global: 'boolean',
      'dry-run': 'boolean',
      sessions: 'value',
      'max-bytes': 'value',
      projects: 'value',
      resume: 'boolean',
    });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory onboard --help');
    return usageError('`mehmory onboard` is not implemented yet', 'mehmory onboard --help');
  },
};
