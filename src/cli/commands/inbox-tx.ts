/**
 * `mehmory inbox-tx` — the transactional inbox helper, reachable through the CLI
 * (issue #17).
 *
 * Same input contract as the bundled `hooks/inbox-tx.mjs` script skills previously
 * located through a Claude-Code-specific plugin-root variable: a subcommand as the
 * first argument, a JSON object on stdin, JSON on stdout. A17: this command calls
 * `runInboxTx` in `src/core/inbox-tx.ts` — the same function the bundled script calls —
 * rather than re-implementing the append/snapshot/clear logic.
 */

import { readStdin } from '../../core/fs.js';
import { parseJsonRecord, runInboxTx, TxError } from '../../core/inbox-tx.js';
import { parseFlags } from '../args.js';
import { EXIT, usageError, type Command, type CommandResult } from '../command.js';

export const command: Command = {
  name: 'inbox-tx',
  summary: 'append, snapshot, or clear inbox entries transactionally (skills call this)',
  usage: 'mehmory inbox-tx <append|snapshot|clear> [--json]',
  help: [
    '  Reads a JSON object from stdin and writes the result as one line of JSON on',
    '  stdout — the same input/output contract as the bundled `hooks/inbox-tx.mjs`',
    '  script, so a skill can call either one interchangeably.',
    '',
    '  append   {inbox, key, entries:[{text, src}]}  -> {appended, skipped}',
    '  snapshot {inbox, key}                         -> {snapshotId, entries}',
    '  clear    {inbox, key, snapshotId}             -> {removed}',
  ],

  run(ctx): CommandResult {
    const parsed = parseFlags(ctx.argv, {});
    if (!parsed.ok) return usageError(parsed.what, 'mehmory inbox-tx --help');

    const [subcommand, extra] = parsed.positional;
    if (subcommand === undefined) {
      return usageError(
        'missing subcommand (expected append|snapshot|clear)',
        'mehmory inbox-tx --help'
      );
    }
    if (extra !== undefined) {
      return usageError(
        `\`inbox-tx\` takes one subcommand (got \`${extra}\`)`,
        'mehmory inbox-tx --help'
      );
    }

    let result: Record<string, unknown>;
    try {
      result = runInboxTx(subcommand, parseJsonRecord(readStdin(), 'stdin'));
    } catch (err) {
      if (!(err instanceof TxError)) throw err;
      return usageError(err.message, 'mehmory inbox-tx --help');
    }

    return { exit: EXIT.OK, lines: [JSON.stringify(result)], data: result };
  },
};
