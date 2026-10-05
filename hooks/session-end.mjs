import {
  finalizeSession,
  runHook
} from "./chunk-2PNAOSNG.mjs";
import "./chunk-MTDJ6MVA.mjs";
import "./chunk-4HAAUZUD.mjs";
import "./chunk-6CBRN5HB.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
