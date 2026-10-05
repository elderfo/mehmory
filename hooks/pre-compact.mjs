import {
  captureDelta,
  runHook
} from "./chunk-7FSOFKBN.mjs";
import {
  isPaused,
  resetStopCount
} from "./chunk-WB3BMRQX.mjs";
import "./chunk-572P3JTD.mjs";
import {
  logError,
  pathExists
} from "./chunk-H34NFU7U.mjs";

// src/hooks/pre-compact.ts
runHook("PreCompact", (input, project, host, config) => {
  if (!config.hooks.pre_compact.enabled || isPaused(input.session_id)) return {};
  const transcript = input.transcript_path;
  if (transcript === void 0 || !pathExists(transcript)) {
    logError({
      code: "E_TRANSCRIPT_PARSE",
      kind: "informational",
      what: "PreCompact payload carried no readable transcript_path",
      consequence: "Nothing was captured at this compaction; the next session start finalizes what is left"
    });
    return {};
  }
  const captured = captureDelta(input.session_id, transcript, project, host, config);
  if ((captured.failed ?? 0) === 0) resetStopCount(input.session_id);
  return { stats: { captured_entries: captured.appended } };
});
