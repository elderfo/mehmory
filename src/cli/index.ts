#!/usr/bin/env node
/**
 * `mehmory` — the CLI entry point (criteria 2 and 3).
 *
 * A17: this file parses argv, picks an exit code and writes bytes. Everything it reports
 * was computed in `src/core/`. It is the one place in the product allowed to call
 * `process.exit` — A11 bans that in core precisely so this boundary can exist.
 */

import { setCliMode } from '../core/errors.js';
import { loadConfig } from '../core/config.js';
import {
  CLI_JSON_SCHEMA,
  E_USAGE,
  formatEnvelopeError,
  renderEnvelope,
} from './envelope.js';
import { EXIT, type Command, type CommandResult } from './command.js';
import { VERSION } from './package-info.js';

import { command as init } from './commands/init.js';
import { command as doctor } from './commands/doctor.js';
import { command as status } from './commands/status.js';
import { command as stats } from './commands/stats.js';
import { command as search } from './commands/search.js';
import { command as onboard } from './commands/onboard.js';
import { command as purge } from './commands/purge.js';

/**
 * The command registry — one `command` export per file in `commands/`.
 *
 * Complete from the first commit, including the files whose bodies land later: three
 * units write commands in parallel worktrees, and a registry each of them had to edit
 * would be a guaranteed merge conflict on the one file none of them owns.
 */
const COMMANDS: readonly Command[] = [init, doctor, status, stats, search, onboard, purge];

function globalHelp(): readonly string[] {
  const width = Math.max(...COMMANDS.map(c => c.name.length));
  return [
    'mehmory — memory for Claude Code',
    '',
    'Usage: mehmory <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map(c => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Options:',
    '  --json            emit a single-line JSON envelope instead of text',
    '  --help, -h        show this help',
    '  --version, -v     print the installed version',
    '',
    'Run `mehmory <command> --help` for a command’s flags.',
  ];
}

function commandHelp(command: Command): readonly string[] {
  return [`Usage: ${command.usage}`, '', command.summary, '', ...command.help];
}

/** Write a result out in whichever of the two output contracts applies (U9). */
function emit(name: string, result: CommandResult, json: boolean): void {
  if (json) {
    // Exactly one line on stdout and nothing else — including on failure, which is the
    // whole point of the contract (criterion 3).
    process.stdout.write(
      renderEnvelope({
        schema: CLI_JSON_SCHEMA,
        command: name,
        ok: result.ok ?? result.exit === EXIT.OK,
        data: result.data ?? {},
        warnings: result.warnings ?? [],
        errors: result.errors ?? [],
      }) + '\n'
    );
    return;
  }

  for (const line of result.lines ?? []) process.stdout.write(line + '\n');
  if (result.selfRendered === true) return;
  for (const warning of result.warnings ?? []) process.stderr.write(`warning: ${warning}\n`);
  for (const error of result.errors ?? []) {
    process.stderr.write(formatEnvelopeError(error) + '\n');
  }
}

function main(): number {
  // Before anything can log: with CLI mode on, a failure here lands in errors.log but
  // does not queue a warning into the user's next Claude Code session.
  setCliMode(true);

  const argv = process.argv.slice(2);
  // Read off the raw argv, not off a command's parse: a usage error that happens before
  // any command runs must still honor `--json` (criterion 3 / UX M3).
  const json = argv.includes('--json');
  const wantsHelp = argv.includes('--help') || argv.includes('-h');

  const nameIndex = argv.findIndex(token => !token.startsWith('-'));
  const name = nameIndex === -1 ? undefined : argv[nameIndex];

  if (name === undefined) {
    if (argv.includes('--version') || argv.includes('-v')) {
      emit('version', { exit: EXIT.OK, lines: [VERSION], data: { version: VERSION } }, json);
      return EXIT.OK;
    }
    if (wantsHelp || argv.length === 0) {
      const lines = globalHelp();
      emit('help', { exit: EXIT.OK, lines, data: { usage: lines.join('\n') } }, json);
      return EXIT.OK;
    }
    return usage(
      `no command given (try one of: ${COMMANDS.map(c => c.name).join(', ')})`,
      json
    );
  }

  const command = COMMANDS.find(c => c.name === name);
  if (!command) {
    return usage(
      `unknown command \`${name}\` (try one of: ${COMMANDS.map(c => c.name).join(', ')})`,
      json
    );
  }

  if (wantsHelp) {
    const lines = commandHelp(command);
    emit(command.name, { exit: EXIT.OK, lines, data: { usage: lines.join('\n') } }, json);
    return EXIT.OK;
  }

  const result = command.run({
    argv: argv.filter((_token, i) => i !== nameIndex),
    json,
    cwd: process.cwd(),
    config: loadConfig(),
  });
  emit(command.name, result, json);
  return result.exit;
}

/** A pre-command usage error: same envelope in JSON mode, stderr in text mode. */
function usage(what: string, json: boolean): number {
  emit(
    'mehmory',
    {
      exit: EXIT.USAGE,
      errors: [
        {
          code: E_USAGE,
          what,
          consequence: 'The command did not run',
          fix: 'mehmory --help',
        },
      ],
    },
    json
  );
  if (!json) for (const line of globalHelp()) process.stderr.write(line + '\n');
  return EXIT.USAGE;
}

/**
 * Last line of defence for criterion 20: the CLI may exit non-zero, but it must never
 * dump a V8 stack trace at a user. Anything that reaches here is a bug, so it is
 * reported in the same template as every other failure and exits 3.
 */
function guarded(): number {
  try {
    return main();
  } catch (err) {
    const json = process.argv.includes('--json');
    emit(
      'mehmory',
      {
        exit: EXIT.FAILED,
        errors: [
          {
            code: 'E_APPEND_FAILED',
            what: err instanceof Error ? err.message : String(err),
            consequence: 'The command stopped before it finished',
          },
        ],
      },
      json
    );
    return EXIT.FAILED;
  }
}

process.exit(guarded());
