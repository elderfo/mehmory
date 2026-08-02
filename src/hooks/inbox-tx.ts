/**
 * `inbox-tx` — the transactional inbox helper skills invoke via Bash (A15).
 *
 * This file is NOT a hook. It lives beside the hook bundles because `hooks/` is where
 * the plugin's bundled `.mjs` output lands, but `hooks.json` never registers it. It is
 * CLI-shaped: a subcommand in argv[2], JSON on stdin, JSON on stdout, exit 0 on success
 * and exit 1 with a one-line stderr message on failure. The U2 no-stderr rule that binds
 * the five hook entrypoints is deliberately not applied here — a skill that silently
 * half-completed a transaction is worse than one that is told it failed.
 *
 * The validation and the append/snapshot/clear logic itself live in `src/core/inbox-tx.ts`
 * — this file is a thin stdin/argv adapter over it (A17). `mehmory inbox-tx` on the CLI
 * (`src/cli/commands/inbox-tx.ts`) calls the same core module, so the two entry points
 * share one implementation rather than duplicating it.
 *
 * Subcommands: see `src/core/inbox-tx.ts`.
 */

import { loadConfig } from '../core/config.js';
import { parseJsonRecord, runInboxTx } from '../core/inbox-tx.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => chunks.push(String(chunk)));
    process.stdin.on('end', () => {
      resolve(chunks.join(''));
    });
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const subcommand = process.argv[2] ?? '';
  const stdin = await readStdin();
  const input = parseJsonRecord(stdin, 'stdin');
  const result = runInboxTx(subcommand, input, loadConfig());
  process.stdout.write(JSON.stringify(result) + '\n');
}

try {
  await main();
} catch (err) {
  process.stderr.write(`inbox-tx: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
