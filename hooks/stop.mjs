import {
  captureDelta,
  incrementStopCount,
  isPaused,
  resetStopCount,
  runHook,
  scopePaths
} from "./chunk-WLZIENPZ.mjs";
import {
  loadConfig
} from "./chunk-FK65OKCK.mjs";

// src/hooks/stop.ts
import { dirname } from "path";
import { fileURLToPath } from "url";
var HOOK_DIR = dirname(fileURLToPath(import.meta.url));
function blockReason(key, sessionId) {
  const payload = JSON.stringify({
    inbox: scopePaths(key).inboxFile,
    key,
    entries: [{ text: "<the learning>", src: sessionId }]
  });
  return [
    "mehmory: save this stretch of the session before stopping.",
    "Append anything durable \u2014 decisions made, corrections received, gotchas found since the last capture \u2014",
    "as one short line each. Use /mehmory:remember, or run:",
    // Heredoc, not `echo '<json>' |`: the learning is model-written prose and a single
    // quote in it would end the shell quote and break the command. A quoted heredoc
    // delimiter passes the body through to stdin literally.
    `node ${HOOK_DIR}/inbox-tx.mjs append <<'JSON'
${payload}
JSON
`,
    "Nothing durable to save? Say so and stop. This fires once per threshold; normal stopping resumes after this pass."
  ].join(" ");
}
runHook("Stop", (input, project) => {
  if (input.stop_hook_active === true) return {};
  const config = loadConfig();
  if (!config.hooks.stop.enabled || isPaused(input.session_id)) return {};
  const count = incrementStopCount(input.session_id);
  if (count < config.stop.capture_threshold) return { stats: { stop_count: count } };
  const captured = captureDelta(input.session_id, input.transcript_path, project, config);
  resetStopCount(input.session_id);
  return {
    json: { decision: "block", reason: blockReason(project, input.session_id) },
    stats: { stop_count: count, captured_entries: captured.appended }
  };
});
