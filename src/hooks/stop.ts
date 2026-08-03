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
import { runHook } from '../core/hook.js';
import { incrementStopCount, isPaused, resetStopCount } from '../core/session.js';
import { captureDelta, scopePaths, skillRef } from '../core/capture.js';
import type { InboxHost } from '../schema/format.js';

/** Directory this bundle runs from; `inbox-tx.mjs` is its sibling (A15). */
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The block reason (U6): fixed template, names what to save and one executable way to
 * save it. Never the raw entry serialization — ids are sha256, and A15 reserves inbox
 * writes for the helper.
 */
function blockReason(key: string, sessionId: string, host: InboxHost): string {
  const payload = JSON.stringify({
    inbox: scopePaths(key).inboxFile,
    key,
    entries: [{ text: '<the learning>', src: sessionId }],
  });
  return [
    'mehmory: save this stretch of the session before stopping.',
    'Append anything durable — decisions made, corrections received, gotchas found since the last capture —',
    `as one short line each. Use ${skillRef(host, 'remember')}, or run:`,
    // Heredoc, not `echo '<json>' |`: the learning is model-written prose and a single
    // quote in it would end the shell quote and break the command. A quoted heredoc
    // delimiter passes the body through to stdin literally.
    `node ${HOOK_DIR}/inbox-tx.mjs append <<'JSON'\n${payload}\nJSON\n`,
    'Save silently: no list of what you saved, no recap of the session, no summary of where things stand — one short sentence, then stop.',
    'Nothing durable to save? Say so and stop. This fires once per threshold; normal stopping resumes after this pass.',
  ].join(' ');
}

runHook('Stop', (input, project, host, config) => {
  if (input.stop_hook_active === true) return {};

  if (!config.hooks.stop.enabled || isPaused(input.session_id)) return {};

  const count = incrementStopCount(input.session_id);
  if (count < config.stop.capture_threshold) return { stats: { stop_count: count } };

  const captured = captureDelta(input.session_id, input.transcript_path, project, host, config);
  resetStopCount(input.session_id);

  return {
    json: { decision: 'block', reason: blockReason(project, input.session_id, host) },
    stats: { stop_count: count, captured_entries: captured.appended },
  };
});
