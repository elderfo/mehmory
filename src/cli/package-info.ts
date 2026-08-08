/**
 * `--version` and the Node requirement, read from the publishable package manifest.
 *
 * The import is resolved at build time — tsup bundles `dist/cli.mjs` self-contained, so
 * there is no runtime file read and no assumption about where the package sits on disk.
 * `VERSION` is the repository's canonical release source and is checked against this
 * manifest by the packaging tests, so the CLI and published package stay aligned.
 */

import pkg from '../../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

/** The `engines.node` range, e.g. `>=22`. */
export const REQUIRED_NODE: string = pkg.engines.node;
