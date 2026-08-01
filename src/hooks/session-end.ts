/**
 * SessionEnd hook: hand the final delta forward and clean up (criterion 13).
 *
 * "Background final distill" is not available to a synchronous hook in a dying process
 * (spec gap 5), so the work splits: distill now (the transcript may be gone later),
 * enqueue the *write* as a durable job, and let the next SessionStart apply it. All of
 * that lives in `finalizeSession` (A12, issue #16) — this adapter just calls it.
 */

import { runHook } from '../core/hook.js';
import { finalizeSession } from '../core/capture.js';

runHook('SessionEnd', (input, project) => {
  const result = finalizeSession(input.session_id, input.transcript_path, project);
  return { stats: { captured_entries: result.capturedEntries } };
});
