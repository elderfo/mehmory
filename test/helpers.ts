import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

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
 * True when `dir` is a throwaway temp directory — i.e. safe to use as MEHMORY_HOME (or,
 * with `realDirName: '.codex'`, as CODEX_HOME).
 *
 * The guard is positive (must be under the OS temp dir), not a blocklist of the real
 * home: a test that computes the wrong path fails here rather than writing somewhere
 * unexpected that merely isn't the real store.
 */
export function isHermeticHome(dir: string | undefined, realDirName = '.mehmory'): boolean {
  if (!dir) return false;
  const resolved = resolve(dir);
  if (resolved === resolve(join(homedir(), realDirName))) return false;
  return resolved.startsWith(resolve(tmpdir()));
}

/**
 * Environment for a spawned subprocess (a built `hooks/*.mjs` fixture test).
 *
 * MUST be used instead of `process.env` when spawning: the in-process MEHMORY_HOME /
 * CODEX_HOME guards cannot see a child that inherited the developer's real home. `HOME`
 * is redirected too, so a child that falls back to `~/.mehmory`, `~/.codex`, or reads
 * `~/.claude` still lands in the temp dir (criterion 21).
 *
 * Throws if called outside a test (no hermetic MEHMORY_HOME/CODEX_HOME set) — failing
 * loudly is the point of the guard.
 */
export function hermeticEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = process.env.MEHMORY_HOME;
  if (home === undefined || !isHermeticHome(home)) {
    throw new Error(
      `hermeticEnv: MEHMORY_HOME is ${home ?? '(unset)'}, not a temp dir. ` +
        'Call this inside a test, after the setup hook has created one.'
    );
  }
  const codexHome = process.env.CODEX_HOME;
  if (codexHome === undefined || !isHermeticHome(codexHome, '.codex')) {
    throw new Error(
      `hermeticEnv: CODEX_HOME is ${codexHome ?? '(unset)'}, not a temp dir. ` +
        'Call this inside a test, after the setup hook has created one.'
    );
  }

  const env = { ...process.env, MEHMORY_HOME: home, HOME: home, CODEX_HOME: codexHome, ...extra };

  // `extra` is applied last so a test can point HOME at a fake ~/.claude (see
  // createFakeClaudeHome) — which also means `extra` can punch straight through the
  // redirects above. Re-check afterwards: this is the only guard a CLI subprocess gets,
  // since the in-process MEHMORY_HOME/CODEX_HOME checks in setup.ts cannot see a child.
  for (const [key, realDirName] of [
    ['MEHMORY_HOME', '.mehmory'],
    ['HOME', '.mehmory'],
    ['CODEX_HOME', '.codex'],
  ] as const) {
    if (!isHermeticHome(env[key], realDirName)) {
      throw new Error(
        `hermeticEnv: ${key} would be ${env[key]} in the child, not a temp dir. ` +
          'A spawned CLI must not be able to reach the real ~/.mehmory, ~/.codex, or ~/.claude.'
      );
    }
  }

  return env;
}

/**
 * Encode a filesystem path the way Claude Code names its transcript directories:
 * every path separator and `.` becomes `-`, so `/home/u/dev/repo` becomes
 * `-home-u-dev-repo` under `~/.claude/projects/`.
 */
export function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[/\\.]/g, '-');
}

/**
 * Build a fake `~/.claude` tree and return the HOME directory that contains it —
 * pass it as `hermeticEnv({ HOME: … })` when spawning, or set `process.env.HOME`.
 *
 * `projects` maps a project's real filesystem path to its sessions, and each session
 * maps a session id to the JSONL transcript lines it holds. Directories are created
 * under `<home>/.claude/projects/<encoded>/<session-id>.jsonl`.
 *
 * A project path with **no** sessions still gets its directory, which is how a test
 * builds the `unresolvable` case: a decoded path that no longer exists on disk.
 */
export function createFakeClaudeHome(
  projects: Record<string, Record<string, readonly string[]>>
): string {
  const home = createTempDir('mehmory-claude');
  for (const [projectPath, sessions] of Object.entries(projects)) {
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectPath));
    mkdirSync(dir, { recursive: true });
    for (const [sessionId, lines] of Object.entries(sessions)) {
      writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map(l => l + '\n').join(''));
    }
  }
  return home;
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
