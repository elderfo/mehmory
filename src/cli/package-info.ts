/**
 * `--version` and the Node requirement, read from `package.json` itself.
 *
 * The import is resolved at build time — tsup bundles `dist/cli.mjs` self-contained, so
 * there is no runtime file read and no assumption about where the package sits on disk.
 * Both values therefore cannot drift from the manifest that npm actually publishes.
 */

import pkg from '../../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

/** The `engines.node` range, e.g. `>=22`. */
export const REQUIRED_NODE: string = pkg.engines.node;
