import {
  finalizeSession,
  runHook
} from "./chunk-5P7GCIXJ.mjs";
import "./chunk-EAC7QWRN.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config);
  return { stats: { captured_entries: result.capturedEntries } };
});
