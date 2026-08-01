import {
  captureDelta,
  isPaused,
  resetStopCount,
  runHook
} from "./chunk-WLZIENPZ.mjs";
import {
  loadConfig
} from "./chunk-FK65OKCK.mjs";

// src/hooks/pre-compact.ts
runHook("PreCompact", (input, project) => {
  const config = loadConfig();
  if (!config.hooks.pre_compact.enabled || isPaused(input.session_id)) return {};
  const captured = captureDelta(input.session_id, input.transcript_path, project);
  resetStopCount(input.session_id);
  return { stats: { captured_entries: captured.appended } };
});
