/**
 * The `--json` transport envelope (plan criterion 3, U9).
 *
 * `CLI_JSON_SCHEMA` lives here and **not** in `src/schema/format.ts`: that file versions
 * the wiki format under A4, while this versions a CLI transport shape. Bumping one must
 * never be read as bumping the other.
 */

import type { MehmoryError } from '../core/errors.js';

/** Version of the envelope shape below. Bump only on a breaking change to it. */
export const CLI_JSON_SCHEMA = 1;

/**
 * One `errors[]` element: the `MehmoryError` fields minus the `Details:` path, so a
 * model reaches the code and the remedy without parsing prose (criterion 3 / U10).
 */
export interface EnvelopeError {
  readonly code: string;
  readonly what: string;
  readonly consequence: string;
  /** A runnable command, or absent. Never prose (U10). */
  readonly fix?: string;
}

/**
 * Code used for argument-parsing failures.
 *
 * It is a CLI-level code, not a member of `ERROR_KINDS`: nothing in `src/core/` can
 * raise a usage error, and the registry is the library's, not the CLI's.
 */
export const E_USAGE = 'E_USAGE';

/** Drop a `MehmoryError` into the envelope's element shape. */
export function toEnvelopeError(error: MehmoryError): EnvelopeError {
  return {
    code: error.code,
    what: error.what,
    consequence: error.consequence,
    ...(error.kind === 'actionable' ? { fix: error.fix } : {}),
  };
}

/** Render one envelope element as the U1 user-facing line (text mode, stderr). */
export function formatEnvelopeError(error: EnvelopeError): string {
  const fix = error.fix === undefined ? '' : ` Fix: ${error.fix}.`;
  return `MEHMORY ${error.code}: ${error.what}. ${error.consequence}.${fix}`;
}

/** The envelope, exactly as it appears on stdout. */
export interface Envelope {
  readonly schema: number;
  readonly command: string;
  readonly ok: boolean;
  readonly data: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  readonly errors: readonly EnvelopeError[];
}

/** Serialize an envelope to the single line the contract promises. */
export function renderEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}
