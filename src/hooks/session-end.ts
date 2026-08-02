/**
 * SessionEnd hook: hand the final delta forward and clean up (criterion 13).
 *
 * "Background final distill" is not available to a synchronous hook in a dying process
 * (spec gap 5), so the work splits: distill now (the transcript may be gone later),
 * enqueue the *write* as a durable job, and let the next SessionStart apply it. All of
 * that lives in `finalizeSession` (A12, issue #16) — this adapter just calls it.
 */

import { loadConfig } from '../core/config.js';
import { runHook } from '../core/hook.js';
import { finalizeSession } from '../core/capture.js';

runHook('SessionEnd', (input, project, host) => {
  const config = loadConfig();
  // Disabling this event means this event does nothing — the session stays pending and
  // the next SessionStart finalizes it. Skipping is not discarding (F3-1).
  if (!config.hooks.session_end.enabled) return {};

  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config);
  return { stats: { captured_entries: result.capturedEntries } };
});
