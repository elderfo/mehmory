import {
  runHook
} from "./chunk-G6TCZEZQ.mjs";
import {
  finalizeSession
} from "./chunk-BP2EVYWE.mjs";
import "./chunk-ZQKNVQBL.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return {
    stats: {
      captured_entries: result.capturedEntries,
      deferred: result.deferred ?? false,
      ...result.markerFailed ? { marker_failed: true } : {}
    }
  };
});
