import {
  finalizeSession,
  runHook
} from "./chunk-2KPNGYRS.mjs";
import "./chunk-RSYE4VWA.mjs";
import "./chunk-BEEOLIQD.mjs";
import "./chunk-3R4TR2B4.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
