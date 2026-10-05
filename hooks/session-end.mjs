import {
  finalizeSession,
  runHook
} from "./chunk-TWVKLHRU.mjs";
import "./chunk-RMANWE5C.mjs";
import "./chunk-MQAFAKX4.mjs";
import "./chunk-PL4QONDN.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
