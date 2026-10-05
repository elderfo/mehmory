import {
  runHook
} from "./chunk-G6TCZEZQ.mjs";
import {
  captureBeforeCompact
} from "./chunk-BP2EVYWE.mjs";
import "./chunk-ZQKNVQBL.mjs";

// src/hooks/pre-compact.ts
runHook("PreCompact", (input, project, host, config) => {
  const captured = captureBeforeCompact(
    input.session_id,
    input.transcript_path,
    project,
    host,
    config
  );
  return captured ? { stats: { captured_entries: captured.appended } } : {};
});
