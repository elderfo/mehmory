import {
  runHook
} from "./chunk-RTT2NKDM.mjs";
import {
  captureBeforeCompact
} from "./chunk-S6YFTPNW.mjs";
import "./chunk-PWN6QP6F.mjs";

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
