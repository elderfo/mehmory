import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default function setup(): void {
  if (!existsSync(join(process.cwd(), 'dist', 'cli.mjs'))) {
    execFileSync('pnpm', ['build'], { cwd: process.cwd(), stdio: 'inherit' });
  }
}
