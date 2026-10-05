import {
  finalizeSession,
  runHook
} from "./chunk-55AHPQ2I.mjs";
import "./chunk-GSMVMEH2.mjs";
import "./chunk-ZLN3ZXCW.mjs";
import "./chunk-2IVUMMAS.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
