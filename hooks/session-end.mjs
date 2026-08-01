import {
  enqueueJob
} from "./chunk-IX7ITTR5.mjs";
import {
  appendLogEntry,
  deleteSessionState,
  distillDelta,
  distillJobPayload,
  isPaused,
  runHook,
  scopePaths
} from "./chunk-WLZIENPZ.mjs";
import {
  INDEX_LOCK_RETRY_COUNT,
  INDEX_LOCK_RETRY_INTERVAL_MS,
  loadConfig,
  logError,
  mehmoryHome,
  pathExists
} from "./chunk-FK65OKCK.mjs";

// src/hooks/session-end.ts
import { join, relative } from "path";

// src/core/git.ts
import { execFileSync } from "child_process";
function commitPaths(paths, message, cwd) {
  const opts = cwd ? { stdio: "pipe", cwd } : { stdio: "pipe" };
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], opts);
  } catch {
    const error = {
      code: "E_GIT_COMMIT",
      kind: "informational",
      what: "Not in a git repository",
      consequence: "Commit failed; memory was not recorded"
    };
    logError(error);
    return { ok: false };
  }
  try {
    execFileSync("git", ["add", "--", ...paths], opts);
  } catch (err) {
    const error = {
      code: "E_GIT_COMMIT",
      kind: "informational",
      what: err instanceof Error ? err.message : String(err),
      consequence: "Failed to stage paths; commit aborted"
    };
    logError(error);
    return { ok: false };
  }
  for (let attempt = 0; attempt <= INDEX_LOCK_RETRY_COUNT; attempt++) {
    try {
      execFileSync("git", ["commit", "--no-gpg-sign", "-m", message], {
        ...opts,
        stdio: "pipe"
      });
      return { ok: true };
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      const isIndexLock = stderr.includes("index.lock") || stderr.includes("fatal: Unable to process");
      if (isIndexLock && attempt < INDEX_LOCK_RETRY_COUNT) {
        const end = Date.now() + INDEX_LOCK_RETRY_INTERVAL_MS;
        while (Date.now() < end) {
        }
        continue;
      }
      if (isIndexLock) {
        return { ok: false, deferred: true };
      }
      const error = {
        code: "E_GIT_COMMIT",
        kind: "informational",
        what: stderr,
        consequence: "Commit failed; tree left staged for manual recovery"
      };
      logError(error);
      return { ok: false, deferred: true };
    }
  }
  return { ok: false };
}

// src/hooks/session-end.ts
runHook("SessionEnd", (input, project) => {
  const config = loadConfig();
  if (!config.hooks.session_end.enabled || isPaused(input.session_id)) {
    deleteSessionState(input.session_id);
    return {};
  }
  const entries = distillDelta(input.session_id, input.transcript_path);
  if (entries.length > 0) {
    enqueueJob(distillJobPayload(project, entries), "distill-final");
  }
  appendLogEntry(
    project,
    "session-end",
    `${String(entries.length)} entries queued for integration (session ${input.session_id})`
  );
  const home = mehmoryHome();
  const paths = scopePaths(project);
  const touched = [paths.logFile, paths.inboxFile].filter(pathExists).map((path) => relative(home, path));
  if (touched.length > 0 && pathExists(join(home, ".git"))) {
    commitPaths(touched, `mehmory: session ${input.session_id} ended`, home);
  }
  deleteSessionState(input.session_id);
  return { stats: { captured_entries: entries.length } };
});
