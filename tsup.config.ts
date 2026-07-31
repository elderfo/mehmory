import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Hook entrypoints are discovered, not listed: the units writing src/hooks/*.ts land at
// different times, and an explicit entry for a file that does not exist yet fails the
// build for everyone else. Zero matches means the second build is simply omitted.
const hookEntries = existsSync('src/hooks')
  ? readdirSync('src/hooks')
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(f => `src/hooks/${f}`)
  : [];

// Same existsSync guard as the hook bundles, and for the same reason: `src/cli/index.ts`
// is written by a later unit, and a hard-coded entry for a file that does not exist yet
// breaks the build for everyone else.
const cliEntry = existsSync('src/cli/index.ts') ? ['src/cli/index.ts'] : [];

export default defineConfig([
  {
    // Library: hook and CLI internals are deliberately excluded — they are entrypoints
    // for the plugin host and for a user respectively, never importable library surface
    // (A12, and A17 mirroring it).
    entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/hooks/**', '!src/cli/**'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist'
  },
  ...(hookEntries.length > 0
    ? [
        {
          // Plugin bundles: self-contained .mjs, no node_modules resolution at runtime.
          entry: hookEntries,
          format: ['esm'],
          bundle: true,
          noExternal: [/.*/],
          dts: false,
          sourcemap: false,
          clean: false,
          outDir: 'hooks',
          outExtension: () => ({ js: '.mjs' })
        }
      ]
    : []),
  ...(cliEntry.length > 0
    ? [
        {
          // CLI: one self-contained ESM bundle invoked via package.json `bin`.
          entry: { cli: 'src/cli/index.ts' },
          format: ['esm' as const],
          bundle: true,
          noExternal: [/.*/],
          splitting: false,
          dts: false,
          sourcemap: false,
          clean: false,
          outDir: 'dist',
          outExtension: () => ({ js: '.mjs' })
        }
      ]
    : [])
]);
