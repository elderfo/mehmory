import {
  captureDelta,
  runHook,
  scopePaths,
  skillRef
} from "./chunk-IBEFNJ6W.mjs";
import {
  incrementStopCount,
  isPaused,
  resetStopCount
} from "./chunk-2REIYSZQ.mjs";

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
  const helper = `${HOOK_DIR}/inbox-tx.mjs`.replace(/'/g, `'\\''`);
  return `node '${helper}' append <<'JSON'
${payload}
JSON
`;
}
var STOP_NUDGES = {
  "claude-code": { carriesCommand: false, output: (reason) => ({ context: reason }) },
  codex: { carriesCommand: true, output: (reason) => ({ json: { decision: "block", reason } }) }
};
function blockReason(key, sessionId, host) {
  const save = STOP_NUDGES[host].carriesCommand ? `Use ${skillRef(host, "remember")}, or run:
${appendCommand(key, sessionId)}` : `${skillRef(host, "remember")} saves them.`;
  return [
    "mehmory: before stopping, append anything durable from this stretch \u2014",
    "decisions, corrections, gotchas \u2014 as one short line each.",
    save,
    "Save silently: one short sentence, no recap of what you saved or where things stand,",
    "then stop. Nothing durable? Say so and stop. Fires once per threshold."
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
    ...STOP_NUDGES[host].output(blockReason(project, input.session_id, host)),
    stats: { stop_count: count, captured_entries: captured.appended }
  };
});
