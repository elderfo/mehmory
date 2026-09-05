import {
  captureDelta,
  runHook
} from "./chunk-VH3KEXT5.mjs";
import {
  isPaused,
  logError,
  pathExists,
  resetStopCount
} from "./chunk-Y2I6CIDU.mjs";

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
  resetStopCount(input.session_id);
  return { stats: { captured_entries: captured.appended } };
});
