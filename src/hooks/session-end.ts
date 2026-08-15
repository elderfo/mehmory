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

runHook('SessionEnd', (input, project, host, config) => {
  // Disabling this event means this event does nothing — the session stays pending and
  // the next SessionStart finalizes it. Skipping is not discarding (F3-1).
  if (!config.hooks.session_end.enabled) return {};

  // Defer on an absent transcript: ACP writes its rollout after SessionEnd fires, so a
  // not-yet-flushed transcript must stay pending for the next start's sweep rather than
  // retiring the session and losing the content (F3-1 sibling — a race must never destroy
  // un-captured material).
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true,
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
