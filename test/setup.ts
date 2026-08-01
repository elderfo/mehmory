/** Test setup: guard against touching real ~/.mehmory (done-when criterion 16). */

import { beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, isHermeticHome } from './helpers.js';

const originalHome = process.env.MEHMORY_HOME;
const originalCodexHome = process.env.CODEX_HOME;
let setupTempDir: string;
let setupCodexTempDir: string;

// Git exports these to hook processes. Tests that shell out to git (identity,
// commitPaths, initStore) would otherwise inherit the *outer* repository's index
// when the suite runs from a pre-commit hook or a CI step invoked by git, and
// `git worktree add` fails with "index file open failed: Not a directory".
// Scrubbed once here rather than at each execSync call site.
for (const v of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) {
  // Reflect.deleteProperty behaves exactly like `delete process.env[v]` here;
  // the plain `delete` operator on a dynamic key is what no-dynamic-delete flags.
  Reflect.deleteProperty(process.env, v);
}

// Make git hermetic for every child process the suite spawns.
//
// Without this the tests inherit the developer's global config. If that sets
// commit.gpgsign=true, each `git commit` blocks on the GPG/1Password agent for
// ~56s and then fails with "failed to write commit object" — so the suite passes
// only while the agent happens to be warm and fails once its cache expires. CI
// has no agent at all, and may also have no user identity, which fails commits
// for a second reason. GIT_CONFIG_* applies to every git invocation without
// touching any repo's own config.
process.env['GIT_CONFIG_COUNT'] = '3';
process.env['GIT_CONFIG_KEY_0'] = 'commit.gpgsign';
process.env['GIT_CONFIG_VALUE_0'] = 'false';
process.env['GIT_CONFIG_KEY_1'] = 'user.name';
process.env['GIT_CONFIG_VALUE_1'] = 'mehmory tests';
process.env['GIT_CONFIG_KEY_2'] = 'user.email';
process.env['GIT_CONFIG_VALUE_2'] = 'tests@mehmory.invalid';

beforeEach(() => {
  // Set MEHMORY_HOME to a temp directory for each test
  setupTempDir = createTempDir('mehmory-test');
  process.env.MEHMORY_HOME = setupTempDir;

  // CODEX_HOME gets the same hermetic guard as MEHMORY_HOME, ahead of any Codex code
  // existing yet: no test may ever touch the real ~/.codex once Codex readers/hooks
  // land in a later unit.
  setupCodexTempDir = createTempDir('mehmory-test-codex');
  process.env.CODEX_HOME = setupCodexTempDir;
});

afterEach(() => {
  // A test that unsets MEHMORY_HOME/CODEX_HOME, or repoints either at its real store,
  // would have every subsequent test in the file touching the real thing. Checked
  // before cleanup so the failure names the offending test (criterion 21). Subprocess
  // tests must build their child env with `hermeticEnv()` — this process's guard
  // cannot see a child.
  const current = process.env.MEHMORY_HOME;
  const currentCodex = process.env.CODEX_HOME;

  cleanupTempDir(setupTempDir);
  cleanupTempDir(setupCodexTempDir);
  if (originalHome) {
    process.env.MEHMORY_HOME = originalHome;
  } else {
    delete process.env.MEHMORY_HOME;
  }
  if (originalCodexHome) {
    process.env.CODEX_HOME = originalCodexHome;
  } else {
    delete process.env.CODEX_HOME;
  }

  if (!isHermeticHome(current)) {
    throw new Error(
      `MEHMORY_HOME left as ${current ?? '(unset)'} — tests must not touch the real store. ` +
        'Restore it before the test ends.'
    );
  }
  if (!isHermeticHome(currentCodex, '.codex')) {
    throw new Error(
      `CODEX_HOME left as ${currentCodex ?? '(unset)'} — tests must not touch ~/.codex. ` +
        'Restore it before the test ends.'
    );
  }
});
