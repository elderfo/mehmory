import {
  finalizeSession,
  runHook
} from "./chunk-EDYLBKGV.mjs";
import "./chunk-OI5RI5RL.mjs";
import "./chunk-3T2Z6INZ.mjs";
import "./chunk-DMITHIMK.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
