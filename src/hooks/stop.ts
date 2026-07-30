/**
 * Stop hook: periodic deterministic capture plus one block-with-reason (criterion 11).
 *
 * Layer (a) is the transcript distill, which needs nothing from the model. Layer (b) is
 * the block: once per threshold crossing, the model is asked to write down what only it
 * knows. `stop_hook_active` guards the loop — a Stop caused by our own block never
 * counts and never blocks again.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { runHook } from '../core/hook.js';
import { incrementStopCount, isPaused, resetStopCount } from '../core/session.js';
import { captureDelta, scopePaths, STOP_CAPTURE_THRESHOLD } from '../core/capture.js';

/** Directory this bundle runs from; `inbox-tx.mjs` is its sibling (A15). */
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The block reason (U6): fixed template, names what to save and one executable way to
 * save it. Never the raw entry serialization — ids are sha256, and A15 reserves inbox
 * writes for the helper.
 */
function blockReason(key: string, sessionId: string): string {
  const payload = JSON.stringify({
    inbox: scopePaths(key).inboxFile,
    key,
    entries: [{ text: '<the learning>', src: sessionId }],
  });
  return [
    'mehmory: save this stretch of the session before stopping.',
    'Append anything durable — decisions made, corrections received, gotchas found since the last capture —',
    'as one short line each. Use /mehmory:remember, or run:',
    `echo '${payload}' | node ${HOOK_DIR}/inbox-tx.mjs append`,
    'Nothing durable to save? Say so and stop. This fires once per threshold; normal stopping resumes after this pass.',
  ].join(' ');
}

runHook('Stop', (input, project) => {
  if (input.stop_hook_active === true) return {};

  const config = loadConfig();
  if (!config.hooks.stop.enabled || isPaused(input.session_id)) return {};

  const count = incrementStopCount(input.session_id);
  if (count < STOP_CAPTURE_THRESHOLD) return { stats: { stop_count: count } };

  const captured = captureDelta(input.session_id, input.transcript_path, project);
  resetStopCount(input.session_id);

  return {
    json: { decision: 'block', reason: blockReason(project, input.session_id) },
    stats: { stop_count: count, captured_entries: captured.appended },
  };
});
