/**
 * PreCompact hook: capture everything since the last capture, say nothing (criterion 12).
 *
 * The real PreCompact contract has no decision control and no additionalContext, so the
 * spec's "block instructing the model to save state now" is impossible here (spec
 * blocker 1). The deterministic half runs; the model-facing notice moves to the next
 * SessionStart, whose `compact` matcher can actually inject.
 */

import { loadConfig } from '../core/config.js';
import { runHook } from '../core/hook.js';
import { isPaused, resetStopCount } from '../core/session.js';
import { captureDelta } from '../core/capture.js';

runHook('PreCompact', (input, project) => {
  const config = loadConfig();
  if (!config.hooks.pre_compact.enabled || isPaused(input.session_id)) return {};

  const captured = captureDelta(input.session_id, input.transcript_path, project);
  // A capture is a capture whichever hook made it: the Stop counter restarts here too.
  resetStopCount(input.session_id);

  return { stats: { captured_entries: captured.appended } };
});
