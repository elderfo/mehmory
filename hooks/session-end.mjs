import {
  finalizeSession,
  runHook
} from "./chunk-VH3KEXT5.mjs";
import "./chunk-Y2I6CIDU.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
