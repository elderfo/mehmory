import {
  finalizeSession,
  runHook
} from "./chunk-CN7YET36.mjs";
import "./chunk-FR4W5LZ6.mjs";
import "./chunk-572P3JTD.mjs";
import "./chunk-H34NFU7U.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
