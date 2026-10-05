import {
  finalizeSession,
  runHook
} from "./chunk-I7LL5VYT.mjs";
import "./chunk-TQ5IOPZC.mjs";
import "./chunk-MGH656ZU.mjs";
import "./chunk-2EYGJ7GZ.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
