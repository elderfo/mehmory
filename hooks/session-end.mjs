import {
  finalizeSession,
  runHook
} from "./chunk-L2WWXAGT.mjs";
import "./chunk-Q3XCVOKA.mjs";

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config);
  return { stats: { captured_entries: result.capturedEntries } };
});
