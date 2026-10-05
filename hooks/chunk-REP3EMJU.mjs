import {
  INBOX_HOSTS,
  currentAgentName,
  loadConfig,
  openSession,
  recordStat,
  resolveProjectKey
} from "./chunk-QGTGVXJ6.mjs";
import {
  logError,
  readStdin
} from "./chunk-PWN6QP6F.mjs";

// src/core/host.ts
var DEFAULT_HOST = "claude-code";
function isKnownHost(value) {
  return INBOX_HOSTS.includes(value);
}
function resolveHost(arg) {
  const trimmed = arg?.trim();
  if (trimmed && isKnownHost(trimmed)) return trimmed;
  return detectHostFromEnvironment();
}
function resolveActiveHost(raw) {
  const trimmed = raw?.trim();
  if (trimmed === "none") return "none";
  return trimmed && isKnownHost(trimmed) ? trimmed : void 0;
}
function detectHostFromEnvironment() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return "claude-code";
  return DEFAULT_HOST;
}

// src/core/hook.ts
function parseHookInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { session_id: "" };
    const v = parsed;
    const str = (name) => typeof v[name] === "string" ? v[name] : void 0;
    return {
      session_id: str("session_id") ?? "",
      ...str("transcript_path") !== void 0 ? { transcript_path: str("transcript_path") } : {},
      ...str("hook_event_name") !== void 0 ? { hook_event_name: str("hook_event_name") } : {},
      ...str("cwd") !== void 0 ? { cwd: str("cwd") } : {},
      ...str("source") !== void 0 ? { source: str("source") } : {},
      ...str("prompt") !== void 0 ? { prompt: str("prompt") } : {},
      ...v["stop_hook_active"] === true ? { stop_hook_active: true } : {}
    };
  } catch {
    return { session_id: "" };
  }
}
function renderHookOutput(event, result) {
  if (result.json) return JSON.stringify(result.json);
  if (!result.context) return event === "Stop" ? "{}" : "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: result.context }
  });
}
function suppression(host, config, activeHost) {
  if (!config.hosts[host].enabled) return "host_disabled";
  if (activeHost !== void 0 && activeHost !== host) return "active_host";
  return void 0;
}
function runHook(event, body) {
  const started = Date.now();
  const host = resolveHost(process.argv[2]);
  const config = loadConfig();
  const suppressed = suppression(
    host,
    config,
    resolveActiveHost(process.env["MEHMORY_ACTIVE_HOST"])
  );
  let result = {};
  let project = "unknown";
  try {
    const input = parseHookInput(readStdin());
    project = resolveProjectKey(input.cwd ?? process.cwd());
    if (suppressed === void 0) {
      if (input.session_id.trim() === "") {
        logError({
          code: "E_SESSION_STATE",
          kind: "informational",
          what: `${event} hook received no session_id`,
          consequence: "The invocation was skipped; no session state was read or written"
        });
      } else {
        openSession(
          input.session_id,
          {
            transcriptPath: input.transcript_path,
            host,
            project,
            agent: currentAgentName(config)
          },
          event,
          config
        );
        result = body(input, project, host, config);
      }
    }
  } catch (err) {
    try {
      logError({
        code: "E_APPEND_FAILED",
        kind: "informational",
        what: `${event} hook failed: ${err instanceof Error ? err.message : String(err)}`,
        consequence: "This hook produced no output; the session is unaffected"
      });
    } catch {
    }
    result = {};
  }
  try {
    recordStat({
      project,
      hook: event,
      host,
      ms: Date.now() - started,
      ...suppressed === void 0 ? {} : { suppressed },
      ...result.stats
    });
  } catch {
  }
  const out = renderHookOutput(event, result);
  if (out) process.stdout.write(out);
}

export {
  runHook
};
