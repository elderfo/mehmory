import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
