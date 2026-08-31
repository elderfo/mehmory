import {
  finalizeSession,
  runHook
<<<<<<< HEAD
} from "./chunk-PTXQ5VQ2.mjs";
import "./chunk-V6QKE7VP.mjs";
=======
} from "./chunk-3IPU3PJ5.mjs";
import "./chunk-7GZSEYBF.mjs";
>>>>>>> 2189859 (fix(session): let a resumed session be finalized, and serialize state writes)

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project, host, config) => {
  if (!config.hooks.session_end.enabled) return {};
  const result = finalizeSession(input.session_id, input.transcript_path, project, host, config, {
    deferWhenTranscriptAbsent: true
  });
  return { stats: { captured_entries: result.capturedEntries, deferred: result.deferred ?? false } };
});
