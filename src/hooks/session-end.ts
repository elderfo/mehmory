/**
 * SessionEnd hook: hand the final delta forward and clean up (criterion 13).
 *
 * "Background final distill" is not available to a synchronous hook in a dying process
 * (spec gap 5), so the work splits: distill now (the transcript may be gone later),
 * enqueue the *write* as a durable job, and let the next SessionStart apply it.
 */

import { join, relative } from 'node:path';
import { loadConfig } from '../core/config.js';
import { commitPaths } from '../core/git.js';
import { mehmoryHome } from '../core/home.js';
import { runHook } from '../core/hook.js';
import { pathExists } from '../core/fs.js';
import { enqueueJob } from '../core/queue.js';
import { deleteSessionState, isPaused } from '../core/session.js';
import { appendLogEntry, distillDelta, distillJobPayload, scopePaths } from '../core/capture.js';

runHook('SessionEnd', (input, project) => {
  const config = loadConfig();
  if (!config.hooks.session_end.enabled || isPaused(input.session_id)) {
    deleteSessionState(input.session_id);
    return {};
  }

  const entries = distillDelta(input.session_id, input.transcript_path);
  if (entries.length > 0) {
    enqueueJob(distillJobPayload(project, entries), 'distill-final');
  }

  appendLogEntry(
    project,
    'session-end',
    `${String(entries.length)} entries queued for integration (session ${input.session_id})`
  );

  const home = mehmoryHome();
  const paths = scopePaths(project);
  const touched = [paths.logFile, paths.inboxFile]
    .filter(pathExists)
    .map(path => relative(home, path));
  if (touched.length > 0 && pathExists(join(home, '.git'))) {
    commitPaths(touched, `mehmory: session ${input.session_id} ended`, home);
  }

  deleteSessionState(input.session_id);
  return { stats: { captured_entries: entries.length } };
});
