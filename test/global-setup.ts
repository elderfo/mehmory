import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** Subprocess tests import `dist/`, so it must not be older than `src/`. */
export function buildIsStale(root: string): boolean {
  const cli = join(root, 'dist', 'cli.mjs');
  if (!existsSync(cli)) return true;
  return newestMtime(join(root, 'src')) > statSync(cli).mtimeMs;
}

export default function setup(): void {
  const root = process.cwd();
  if (buildIsStale(root)) {
    execFileSync('pnpm', ['build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
}
