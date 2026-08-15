import {
  captureDelta,
  runHook,
  scopePaths,
  skillRef
} from "./chunk-FQHUNOGF.mjs";
import {
  incrementStopCount,
  isPaused,
  resetStopCount
} from "./chunk-W374UQRL.mjs";

// src/hooks/stop.ts
import { dirname } from "path";
import { fileURLToPath } from "url";
var HOOK_DIR = dirname(fileURLToPath(import.meta.url));
function blockReason(key, sessionId, host) {
  const payload = JSON.stringify({
    inbox: scopePaths(key).inboxFile,
    key,
    entries: [{ text: "<the learning>", src: sessionId }]
  });
  return [
    "mehmory: save this stretch of the session before stopping.",
    "Append anything durable \u2014 decisions made, corrections received, gotchas found since the last capture \u2014",
    `as one short line each. Use ${skillRef(host, "remember")}, or run:`,
    // Heredoc, not `echo '<json>' |`: the learning is model-written prose and a single
    // quote in it would end the shell quote and break the command. A quoted heredoc
    // delimiter passes the body through to stdin literally.
    `node ${HOOK_DIR}/inbox-tx.mjs append <<'JSON'
${payload}
JSON
`,
    "Save silently: no list of what you saved, no recap of the session, no summary of where things stand \u2014 one short sentence, then stop.",
    "Nothing durable to save? Say so and stop. This fires once per threshold; normal stopping resumes after this pass."
  ].join(" ");
}
runHook("Stop", (input, project, host, config) => {
  if (input.stop_hook_active === true) return {};
  if (!config.hooks.stop.enabled || isPaused(input.session_id)) return {};
  const count = incrementStopCount(input.session_id);
  if (count < config.stop.capture_threshold) return { stats: { stop_count: count } };
  const captured = captureDelta(input.session_id, input.transcript_path, project, host, config);
  resetStopCount(input.session_id);
  return {
    json: { decision: "block", reason: blockReason(project, input.session_id, host) },
    stats: { stop_count: count, captured_entries: captured.appended }
  };
});
