import {
  captureDelta,
  runHook,
  scopePaths,
  skillRef
} from "./chunk-7BGZXVUT.mjs";
import {
  incrementStopCount,
  isPaused,
  resetStopCount
} from "./chunk-NEVGDLYA.mjs";

// src/hooks/stop.ts
import { dirname } from "path";
import { fileURLToPath } from "url";
var HOOK_DIR = dirname(fileURLToPath(import.meta.url));
function appendCommand(key, sessionId) {
  const payload = JSON.stringify({
    inbox: scopePaths(key).inboxFile,
    key,
    entries: [{ text: "<the learning>", src: sessionId }]
  });
  return `node ${HOOK_DIR}/inbox-tx.mjs append <<'JSON'
${payload}
JSON
`;
}
function blockReason(key, sessionId, host) {
  const save = host === "codex" ? `Use ${skillRef(host, "remember")}, or run:
${appendCommand(key, sessionId)}` : `${skillRef(host, "remember")} saves them.`;
  return [
    "mehmory: before stopping, append anything durable from this stretch \u2014",
    "decisions, corrections, gotchas \u2014 as one short line each.",
    save,
    "Save silently: one short sentence, no recap of what you saved or where things stand,",
    "then stop. Nothing durable? Say so and stop. Fires once per threshold."
  ].join(" ");
}
function blockOutput(reason, host) {
  return host === "codex" ? { json: { decision: "block", reason } } : { context: reason };
}
runHook("Stop", (input, project, host, config) => {
  if (input.stop_hook_active === true) return {};
  if (!config.hooks.stop.enabled || isPaused(input.session_id)) return {};
  const count = incrementStopCount(input.session_id);
  if (count < config.stop.capture_threshold) return { stats: { stop_count: count } };
  const captured = captureDelta(input.session_id, input.transcript_path, project, host, config);
  resetStopCount(input.session_id);
  return {
    ...blockOutput(blockReason(project, input.session_id, host), host),
    stats: { stop_count: count, captured_entries: captured.appended }
  };
});
