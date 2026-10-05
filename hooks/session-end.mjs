import {
  finalizeSession,
  runHook
} from "./chunk-CC4E3AQB.mjs";
import "./chunk-CR4WRARC.mjs";
import "./chunk-WVRKG4UX.mjs";
import "./chunk-S7B7BPQR.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
