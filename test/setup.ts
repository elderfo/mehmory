/** Test setup: guard against touching real ~/.mehmory (done-when criterion 16). */

import { beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const originalHome = process.env.MEHMORY_HOME;

// Git exports these to hook processes. Tests that shell out to git (identity,
// commitPaths, initStore) would otherwise inherit the *outer* repository's index
// when the suite runs from a pre-commit hook or a CI step invoked by git, and
// `git worktree add` fails with "index file open failed: Not a directory".
// Scrubbed once here rather than at each execSync call site.
for (const v of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) {
  delete process.env[v];
}

beforeEach(() => {
  // Set MEHMORY_HOME to a temp directory for each test
  const tempDir = join(tmpdir(), `mehmory-test-${randomBytes(8).toString('hex')}`);
  process.env.MEHMORY_HOME = tempDir;
});

afterEach(() => {
  // Restore original or unset
  if (originalHome) {
    process.env.MEHMORY_HOME = originalHome;
  } else {
    delete process.env.MEHMORY_HOME;
  }
});
