import {
  captureDelta,
  runHook,
  scopePaths,
  skillRef
} from "./chunk-2KPNGYRS.mjs";
import {
  incrementStopCount,
  isPaused,
  resetStopCount
} from "./chunk-RSYE4VWA.mjs";
import "./chunk-BEEOLIQD.mjs";
import {
  logError
} from "./chunk-3R4TR2B4.mjs";

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
  codex: { carriesCommand: true, output: (reason) => ({ json: { decision: "block", reason } }) },
  pi: { carriesCommand: true, output: (reason) => ({ context: reason }) }
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
  const threshold = Math.max(1, Math.ceil(config.stop.capture_threshold));
  const firstCrossing = count === threshold;
  const retry = count > threshold && (count - threshold - 1) % threshold === 0;
  if (!firstCrossing && !retry) return { stats: { stop_count: count } };
  const captured = captureDelta(input.session_id, input.transcript_path, project, host, config);
  if ((captured.failed ?? 0) === 0) resetStopCount(input.session_id);
  else if (count === threshold + 1) {
    logError({
      code: "E_APPEND_FAILED",
      kind: "informational",
      what: `Stop capture still failing for session ${input.session_id}`,
      consequence: "The delta is retained; silent retries now wait one threshold window"
    });
  }
  return {
    ...firstCrossing ? STOP_NUDGES[host].output(blockReason(project, input.session_id, host)) : {},
    stats: { stop_count: count, captured_entries: captured.appended }
  };
});
