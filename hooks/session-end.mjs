import {
  finalizeSession,
  runHook
} from "./chunk-5JQI2FNW.mjs";
import "./chunk-4NHTIPST.mjs";
import "./chunk-VENRADGT.mjs";
import "./chunk-2WDC3JUN.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
