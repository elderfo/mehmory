/**
 * The command contract every file in `src/cli/commands/` implements (criterion 2).
 *
 * A command body parses its own flags, calls `src/core/`, and returns data plus an exit
 * code. It never writes to stdout/stderr and never exits — `src/cli/index.ts` owns both,
 * which is what lets the same body serve human output and the `--json` envelope (U9).
 */

import type { MehmoryConfig } from '../core/config.js';
import type { MehmoryError } from '../core/errors.js';
import { E_USAGE, toEnvelopeError, type EnvelopeError } from './envelope.js';

/**
 * The uniform exit-code contract (criterion 2). Identical across every command, except
 * that `doctor` additionally uses 5 and 6 and never uses `NO_STORE`.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Usage error: unknown command or flag, bad arity, ambiguous selector. */
  USAGE: 1,
  /** The command requires a store and there is none. */
  NO_STORE: 2,
  /** The operation failed (a write or a git call). */
  FAILED: 3,
  /** The user declined a confirmation. */
  ABORTED: 4,
  /** `doctor` only: warnings, no errors. */
  DOCTOR_WARN: 5,
  /** `doctor` only: at least one error-level finding. */
  DOCTOR_ERROR: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Everything a command body is given. */
export interface CommandContext {
  /** argv after the command name. `--json` and `--help` are still present. */
  readonly argv: readonly string[];
  /** True when `--json` appeared anywhere in argv (criterion 3). */
  readonly json: boolean;
  /** Directory the CLI was invoked from. */
  readonly cwd: string;
  /** Loaded once per process and threaded down, never re-read (A21). */
  readonly config: MehmoryConfig;
}

/** Everything a command body hands back. */
export interface CommandResult {
  readonly exit: ExitCode;
  /** stdout lines in human mode; ignored under `--json`. */
  readonly lines?: readonly string[];
  /** The envelope's `data` object; ignored in human mode. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** The envelope's `warnings[]`; printed to stderr in human mode. */
  readonly warnings?: readonly string[];
  /** The envelope's `errors[]`; printed to stderr in human mode. */
  readonly errors?: readonly EnvelopeError[];
  /** Envelope `ok`. Defaults to `exit === EXIT.OK`; `doctor` overrides it for exit 5. */
  readonly ok?: boolean;
  /**
   * Set when `lines` already renders this result's warnings and errors for a human, so
   * text mode must not print them a second time. `doctor` is the case: its findings are
   * its output, and they also populate `warnings[]`/`errors[]` for the envelope.
   */
  readonly selfRendered?: boolean;
}

/** One registered command. */
export interface Command {
  /** The word the user types. */
  readonly name: string;
  /** One line, shown in `mehmory --help`. */
  readonly summary: string;
  /** Usage line, shown in `mehmory <name> --help`. */
  readonly usage: string;
  /** Flag documentation, one line each, shown under the usage line. */
  readonly help: readonly string[];
  run(_ctx: CommandContext): CommandResult;
}

/** A usage error (exit 1) with the runnable remedy U10 requires. */
export function usageError(what: string, fix: string): CommandResult {
  return {
    exit: EXIT.USAGE,
    errors: [
      {
        code: E_USAGE,
        what,
        consequence: 'The command did not run',
        fix,
      },
    ],
  };
}

/** Exit 2: this command needs a store and there is none. `doctor` never returns this. */
export function storeMissing(command: string): CommandResult {
  return {
    exit: EXIT.NO_STORE,
    errors: [
      {
        code: 'E_STORE_INIT',
        what: `no mehmory store found`,
        consequence: `\`mehmory ${command}\` has nothing to read`,
        fix: 'mehmory init',
      },
    ],
  };
}

/** Exit 3: the operation itself failed. */
export function operationFailed(error: MehmoryError): CommandResult {
  return { exit: EXIT.FAILED, errors: [toEnvelopeError(error)] };
}
