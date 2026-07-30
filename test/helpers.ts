import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';

/**
 * Create a temporary directory for tests with a prefixed unique name.
 * Returns the full path to the created directory.
 */
export function createTempDir(prefix: string): string {
  const tempDir = join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * True when `dir` is a throwaway temp directory — i.e. safe to use as MEHMORY_HOME.
 *
 * The guard is positive (must be under the OS temp dir), not a blocklist of the real
 * home: a test that computes the wrong path fails here rather than writing somewhere
 * unexpected that merely isn't `~/.mehmory`.
 */
export function isHermeticHome(dir: string | undefined): boolean {
  if (!dir) return false;
  const resolved = resolve(dir);
  if (resolved === resolve(join(homedir(), '.mehmory'))) return false;
  return resolved.startsWith(resolve(tmpdir()));
}

/**
 * Environment for a spawned subprocess (a built `hooks/*.mjs` fixture test).
 *
 * MUST be used instead of `process.env` when spawning: the in-process MEHMORY_HOME
 * guard cannot see a child that inherited the developer's real home. `HOME` is
 * redirected too, so a child that falls back to `~/.mehmory` or reads `~/.claude`
 * still lands in the temp dir (criterion 21).
 *
 * Throws if called outside a test (no hermetic MEHMORY_HOME set) — failing loudly is
 * the point of the guard.
 */
export function hermeticEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = process.env.MEHMORY_HOME;
  if (home === undefined || !isHermeticHome(home)) {
    throw new Error(
      `hermeticEnv: MEHMORY_HOME is ${home ?? '(unset)'}, not a temp dir. ` +
        'Call this inside a test, after the setup hook has created one.'
    );
  }
  return { ...process.env, MEHMORY_HOME: home, HOME: home, ...extra };
}

/**
 * Clean up a temporary directory after tests.
 * Does not throw if the directory doesn't exist.
 */
export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore errors; directory may already be gone
  }
}
