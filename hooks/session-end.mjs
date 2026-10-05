import {
  finalizeSession,
  runHook
} from "./chunk-ODLV4UIH.mjs";
import "./chunk-2IESAF5R.mjs";
import "./chunk-YPED7F4N.mjs";
import "./chunk-PZNSX44T.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
