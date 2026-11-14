import {
  runHook
} from "./chunk-G6TCZEZQ.mjs";
import {
  captureAtStop,
  scopePaths,
  skillRef
} from "./chunk-BP2EVYWE.mjs";
import "./chunk-ZQKNVQBL.mjs";

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
  const { count, captured, nudge } = captureAtStop(
    input.session_id,
    input.transcript_path,
    project,
    host,
    config,
    input.stop_hook_active
  );
  if (count === void 0) return {};
  if (captured === void 0) return { stats: { stop_count: count } };
  return {
    ...nudge ? STOP_NUDGES[host].output(blockReason(project, input.session_id, host)) : {},
    stats: { stop_count: count, captured_entries: captured.appended }
  };
});
