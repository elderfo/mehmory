import {
  finalizeSession,
  runHook
} from "./chunk-5AZN425K.mjs";
import "./chunk-YIL6L2Y3.mjs";
import "./chunk-JFYN3S32.mjs";
import "./chunk-FJJSKSKJ.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
