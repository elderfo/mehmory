import {
  stripPiSkillEnvelope
} from "./chunk-ZQKNVQBL.mjs";

// src/hooks/pi-extension.ts
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var HOOK_DIR = dirname(fileURLToPath(import.meta.url));
var HOOK_TIMEOUT_MS = 1e4;
var HOOK_EVENTS = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  stop: "Stop",
  "pre-compact": "PreCompact",
  "session-end": "SessionEnd"
};
var CUSTOM_TYPE = "mehmory";
function piSession(ctx) {
  const record = asRecord(ctx);
  const manager = asRecord(record?.["sessionManager"]);
  const cwd = record?.["cwd"];
  if (!manager || typeof cwd !== "string") return void 0;
  const id = call(manager, "getSessionId");
  if (typeof id !== "string" || !id) return void 0;
  const file = call(manager, "getSessionFile");
  const dir = call(manager, "getSessionDir");
  return {
    id,
    cwd,
    ...typeof file === "string" && file ? { file } : {},
    ...typeof dir === "string" && dir ? { dir } : {}
  };
}
function hookPayload(hook, session, fields = {}) {
  return {
    session_id: session.id,
    ...session.file === void 0 ? {} : { transcript_path: session.file },
    cwd: session.cwd,
    hook_event_name: HOOK_EVENTS[hook],
    ...fields
  };
}
function sessionStartSource(reason) {
  if (reason === "reload") return void 0;
  return reason === "resume" || reason === "fork" ? "resume" : "startup";
}
function hookOutputText(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "";
  }
  const record = asRecord(parsed);
  const context = asRecord(record?.["hookSpecificOutput"])?.["additionalContext"];
  if (typeof context === "string") return context;
  const reason = record?.["reason"];
  return record?.["decision"] === "block" && typeof reason === "string" ? reason : "";
}
function runHook(hook, session, fields = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn("node", [join(HOOK_DIR, `${hook}.mjs`), "pi"], {
        // Transcript approval follows `--session-dir`, which only Pi knows about.
        env: session.dir === void 0 ? process.env : { ...process.env, PI_CODING_AGENT_SESSION_DIR: session.dir },
        stdio: ["pipe", "pipe", "ignore"]
      });
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("");
      }, HOOK_TIMEOUT_MS);
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve("");
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(hookOutputText(stdout));
      });
      child.stdin.on("error", () => void 0);
      child.stdin.end(JSON.stringify(hookPayload(hook, session, fields)));
    } catch {
      resolve("");
    }
  });
}
function mehmory(pi) {
  const api = asRecord(pi);
  if (typeof api?.["on"] !== "function") return;
  if (!process.env["MEHMORY_ACTIVE_HOST"]?.trim()) process.env["MEHMORY_ACTIVE_HOST"] = "pi";
  const on = (event, handler) => {
    try {
      api.on(event, async (raw, ctx) => {
        try {
          const session = piSession(ctx);
          return session === void 0 ? void 0 : await handler(asRecord(raw) ?? {}, session);
        } catch {
          return void 0;
        }
      });
    } catch {
    }
  };
  const state = { pendingContext: "", nudged: false };
  on("session_start", async (event, session) => {
    const source = sessionStartSource(event["reason"]);
    if (source === void 0) return void 0;
    state.pendingContext = await runHook("session-start", session, { source });
    return void 0;
  });
  on("before_agent_start", async (event, session) => {
    const prompt = typeof event["prompt"] === "string" ? stripPiSkillEnvelope(event["prompt"]) : "";
    const submitted = await runHook("user-prompt-submit", session, { prompt });
    const content = [state.pendingContext, submitted].filter(Boolean).join("\n");
    state.pendingContext = "";
    return content ? { message: { customType: CUSTOM_TYPE, content, display: false } } : void 0;
  });
  on("agent_before_settle", async (event, session) => {
    if (event["outcome"] !== "completed") return void 0;
    const reason = await runHook("stop", session, { stop_hook_active: state.nudged });
    state.nudged = reason !== "";
    return reason ? {
      entries: [{ type: "custom_message", customType: CUSTOM_TYPE, content: reason, display: true }],
      continue: true
    } : void 0;
  });
  on("session_before_compact", async (_event, session) => {
    await runHook("pre-compact", session);
    return void 0;
  });
  on("session_compact", async (_event, session) => {
    state.pendingContext = await runHook("session-start", session, { source: "compact" });
    return void 0;
  });
  on("session_shutdown", async (event, session) => {
    if (event["reason"] === "reload") return void 0;
    await runHook("session-end", session);
    return void 0;
  });
}
function call(target, method) {
  const fn = target[method];
  if (typeof fn !== "function") return void 0;
  try {
    return fn.call(target);
  } catch {
    return void 0;
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
export {
  mehmory as default,
  hookOutputText,
  hookPayload,
  piSession,
  sessionStartSource
};
