/**
 * PreCompact hook: capture everything since the last capture, say nothing (criterion 12).
 *
 * The real PreCompact contract has no decision control and no additionalContext, so the
 * spec's "block instructing the model to save state now" is impossible here (spec
 * blocker 1). The deterministic half runs; the model-facing notice moves to the next
 * SessionStart, whose `compact` matcher can actually inject.
 *
 * On Codex the payload of this event is **unverified** — the event exists in Codex CLI
 * 0.146.0 but no spike run ever fired it (`docs/TROUBLESHOOTING.md`). So this hook
 * assumes nothing beyond the one field every measured Codex event does carry, checks that
 * field before acting, and treats a payload it does not recognize as nothing to do rather
 * than as an error (A2, A8). It deliberately does not finalize the session: compaction is
 * not an ending, and retiring the session here would leave everything after the
 * compaction with no route into the inbox at all. Durability for that stretch comes from
 * the next session start (issue #24).
 */

import { loadConfig } from '../core/config.js';
import { runHook } from '../core/hook.js';
import { logError } from '../core/errors.js';
import { pathExists } from '../core/fs.js';
import { isPaused, resetStopCount } from '../core/session.js';
import { captureDelta } from '../core/capture.js';

runHook('PreCompact', (input, project, host) => {
  const config = loadConfig();
  if (!config.hooks.pre_compact.enabled || isPaused(input.session_id)) return {};

  const transcript = input.transcript_path;
  if (transcript === undefined || !pathExists(transcript)) {
    logError({
      code: 'E_TRANSCRIPT_PARSE',
      kind: 'informational',
      what: 'PreCompact payload carried no readable transcript_path',
      consequence:
        'Nothing was captured at this compaction; the next session start finalizes what is left',
    });
    return {};
  }

  const captured = captureDelta(input.session_id, transcript, project, host);
  // A capture is a capture whichever hook made it: the Stop counter restarts here too.
  resetStopCount(input.session_id);

  return { stats: { captured_entries: captured.appended } };
});
