import {
  finalizeSession,
  runHook
} from "./chunk-Q72NFL5N.mjs";
import "./chunk-CU44STGN.mjs";
import "./chunk-YZTNJJDP.mjs";
import "./chunk-NTSIN6Z2.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
