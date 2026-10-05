import {
  finalizeSession,
  runHook
} from "./chunk-7NZBOBCP.mjs";
import "./chunk-XTMLEQZP.mjs";
import "./chunk-66YSTZHA.mjs";
import "./chunk-B37S7SCY.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
