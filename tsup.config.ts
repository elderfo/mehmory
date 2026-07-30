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

export default defineConfig([
  {
    // Library: hook internals are deliberately excluded — they are entrypoints for the
    // plugin host, never importable library surface (A12).
    entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/hooks/**'],
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
    : [])
]);
