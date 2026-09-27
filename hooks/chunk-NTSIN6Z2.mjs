// src/core/home.ts
import { homedir } from "os";
import { join } from "path";
function mehmoryHome() {
  const envHome = process.env.MEHMORY_HOME;
  if (envHome) {
    return envHome;
  }
  return join(homedir(), ".mehmory");
}
function codexHome() {
  const envHome = process.env.CODEX_HOME;
  if (envHome) {
    return envHome;
  }
  return join(homedir(), ".codex");
}
function piSessionsDir() {
  const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (envDir) {
    return envDir;
  }
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
}
function statePath(...segments) {
  return join(mehmoryHome(), ".state", ...segments);
}

// src/core/errors.ts
import {
  appendFileSync,
  readFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { createHash } from "crypto";
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
var ERROR_KINDS = {
  E_CONFIG_PARSE: "actionable",
  E_LOCK_TIMEOUT: "informational",
  E_DISTILL_LOSSY: "informational",
  E_STORE_INIT: "actionable",
  E_GIT_COMMIT: "informational",
  E_QUEUE_CLAIM: "informational",
  E_CURSOR_RESET: "informational",
  E_SESSION_STATE: "informational",
  E_TRANSCRIPT_PARSE: "informational",
  E_APPEND_FAILED: "actionable",
  E_ATOMIC_WRITE: "actionable",
  // ─── Run 3 (CLI) ───
  /** A `mehmory search` scan failed or was cut short. Nothing for the user to run. */
  E_SEARCH_FAILED: "informational",
  /** A transcript file could not be read during `onboard`. That session is skipped. */
  E_TRANSCRIPT_READ: "informational",
  /** A `~/.claude/projects/<encoded>` directory decodes to a path that is gone, so its
   * project key cannot be resolved. Listed as unresolvable and skipped, never guessed. */
  E_TRANSCRIPT_DIR_UNRESOLVED: "informational",
  /** `mehmory purge` deleted files but could not commit — the store is left dirty, and
   * the remedy is a real command (`git -C <home> commit -a`). */
  E_PURGE_FAILED: "actionable",
  // ─── Run 4 (Codex host) ───
  /** `mehmory init --host codex` could not read or write a file under `$CODEX_HOME`.
   * Nothing was modified — the file is shared with other tools, so a config mehmory
   * cannot parse is refused rather than overwritten. */
  E_CODEX_INSTALL: "actionable",
  /** mehmory is wired into a Codex that is not there: `$CODEX_HOME` holds mehmory's hook
   * entries but no `config.toml`, so those entries are pointing at nothing. */
  E_CODEX_HARNESS_MISSING: "actionable",
  /** Codex's `[features] hooks` flag is off or unset, so no hook of any tool fires. */
  E_CODEX_HOOKS_DISABLED: "actionable",
  /** `$CODEX_HOME/hooks.json` carries no mehmory entry for one or more events, so those
   * lifecycle events capture and inject nothing under Codex. */
  E_CODEX_HOOKS_UNWIRED: "actionable",
  /** Codex has registered mehmory's hooks but has no trust decision for them, so it
   * skips every one silently: capture never fires and no surface says why (issue #39). */
  E_CODEX_HOOKS_UNTRUSTED: "actionable",
  /** The mehmory skills are not installed for Codex, so the judgment-work commands
   * (integrate, lint, onboard) are unavailable there. Capture still runs. */
  E_CODEX_SKILLS_MISSING: "actionable",
  // ─── Run 5 (agent scopes) ───
  /** A declared agent name is not usable as a directory segment, so the agent runs
   * unnamed and gets no agent scope. Its own code rather than `E_CONFIG_PARSE`: the
   * name usually comes from the environment rather than config, and the hourly warning
   * rate limit is per code — sharing a bucket would let an unrelated config warning
   * suppress the one that tells an operator which agent is misconfigured. */
  E_AGENT_NAME_INVALID: "actionable"
};
var logFileSizeState = null;
var cliMode = false;
function logError(error) {
  const logPath = statePath("errors.log");
  const logDir = dirname(logPath);
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  } catch {
    return;
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const line = `[${timestamp}] ${error.code}: ${error.what}
`;
  const maxSize = 5 * 1024 * 1024;
  if (logFileSizeState === null) {
    try {
      const stat2 = statSync(logPath);
      logFileSizeState = { size: stat2.size, mtime: stat2.mtime.getTime() };
    } catch {
      logFileSizeState = { size: 0, mtime: 0 };
    }
  } else {
    try {
      const stat2 = statSync(logPath);
      const currentMtime = stat2.mtime.getTime();
      if (currentMtime !== logFileSizeState.mtime) {
        logFileSizeState = { size: stat2.size, mtime: currentMtime };
      }
    } catch {
    }
  }
  try {
    appendFileSync(logPath, line, "utf-8");
  } catch {
    return;
  }
  const bytesWritten = Buffer.byteLength(line, "utf-8");
  logFileSizeState.size += bytesWritten;
  if (logFileSizeState.size > maxSize) {
    try {
      const rotatedPath = statePath("errors.log.1");
      if (existsSync(rotatedPath)) unlinkSync(rotatedPath);
      renameSync(logPath, rotatedPath);
      logFileSizeState = { size: 0, mtime: 0 };
    } catch {
    }
  }
  if (!cliMode) recordWarning(error.code);
}
function failOpen(fn, fallback, code) {
  try {
    return fn();
  } catch (err) {
    logError({
      code,
      kind: "informational",
      what: err instanceof Error ? err.message : String(err),
      consequence: "Operation failed; using fallback"
    });
    return fallback;
  }
}
function isWarningRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v["code"] === "string" && typeof v["lastTime"] === "number" && typeof v["count"] === "number";
}
var WARN_RATE_LIMIT_MS = 60 * 60 * 1e3;
var warningsCacheState = null;
function hashFileContents(data) {
  return createHash("sha256").update(data).digest("hex");
}
function getWarningsFromDisk(warningsPath) {
  try {
    const data = readFileSync(warningsPath, "utf-8");
    const contentHash = hashFileContents(data);
    if (warningsCacheState !== null && warningsCacheState.contentHash === contentHash) {
      return warningsCacheState.warnings;
    }
    const parsed = JSON.parse(data);
    const warnings = Array.isArray(parsed) ? parsed.filter(isWarningRecord) : [];
    warningsCacheState = { warnings, contentHash };
    return warnings;
  } catch {
    return [];
  }
}
function recordWarning(code) {
  const warningsPath = statePath("warnings.json");
  const warningsDir = dirname(warningsPath);
  if (!existsSync(warningsDir)) {
    mkdirSync(warningsDir, { recursive: true });
  }
  let warnings = [];
  if (existsSync(warningsPath)) {
    warnings = getWarningsFromDisk(warningsPath);
  }
  const now = Date.now();
  const existingIndex = warnings.findIndex((w) => w.code === code);
  if (existingIndex >= 0) {
    const record = warnings[existingIndex];
    if (!record) {
      warnings.push({ code, lastTime: now, count: 1 });
    } else if (now - record.lastTime < WARN_RATE_LIMIT_MS) {
      return;
    } else {
      record.lastTime = now;
      record.count++;
    }
  } else {
    warnings.push({ code, lastTime: now, count: 1 });
  }
  try {
    const jsonStr = JSON.stringify(warnings, null, 2);
    writeFileSync(warningsPath, jsonStr, "utf-8");
    const contentHash = hashFileContents(jsonStr);
    warningsCacheState = { warnings, contentHash };
  } catch {
  }
}
function readWarningLines(warningsPath) {
  if (!existsSync(warningsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(warningsPath, "utf-8"));
    const warnings = Array.isArray(parsed) ? parsed.filter(isWarningRecord) : [];
    return warnings.map((w) => {
      const kind = ERROR_KINDS[w.code] ?? "informational";
      return `${w.code} (${kind}, ${String(w.count)} occurrences): see ~/.mehmory/.state/errors.log`;
    });
  } catch {
    return [];
  }
}
function pendingWarnings() {
  const warningsPath = statePath("warnings.json");
  const lines = readWarningLines(warningsPath);
  if (!existsSync(warningsPath)) return lines;
  try {
    const emptyJson = JSON.stringify([], null, 2);
    writeFileSync(warningsPath, emptyJson, "utf-8");
    warningsCacheState = { warnings: [], contentHash: hashFileContents(emptyJson) };
  } catch {
  }
  return lines;
}

// src/core/fs.ts
import {
  writeFileSync as writeFileSync2,
  readFileSync as readFileSync2,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fstatSync,
  existsSync as existsSync2,
  statSync as statSync2,
  lstatSync,
  renameSync as renameSync2,
  mkdirSync as mkdirSync2,
  readdirSync,
  rmSync,
  unlinkSync as unlinkSync2,
  realpathSync,
  chmodSync,
  constants
} from "fs";
import { dirname as dirname2 } from "path";
var LOCK_RETRY_COUNT = 50;
var LOCK_RETRY_INTERVAL_MS = 100;
var LOCK_STALE_MS = 3e4;
var INDEX_LOCK_RETRY_COUNT = 1;
var INDEX_LOCK_RETRY_INTERVAL_MS = 100;
var QUEUE_CLAIM_ATTEMPTS = 3;
var QUEUE_STALE_MS = 3e4;
var APPEND_ATOMIC_CEILING_BYTES = 4 * 1024;
function readStdin() {
  try {
    return readFileSync2(0, "utf-8");
  } catch {
    return "";
  }
}
function pathExists(path) {
  return existsSync2(path);
}
function stat(path) {
  return statSync2(path);
}
function lstat(path) {
  return lstatSync(path);
}
function readFile(path) {
  return readFileSync2(path, "utf-8");
}
function readFileFrom(path, offset) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = offset > 0 ? Math.min(offset, size) : 0;
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
function readFileFromNoFollow(path, offset) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    const start = offset > 0 ? Math.min(offset, size) : 0;
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
function mkdir(path) {
  mkdirSync2(path, { recursive: true });
}
function rename(from, to) {
  renameSync2(from, to);
}
function remove(path) {
  unlinkSync2(path);
}
function removeDir(path) {
  rmSync(path, { recursive: true, force: true });
}
function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function listDir(path) {
  return readdirSync(path);
}
function createLockExclusive(path, owner = "") {
  try {
    const fd = openSync(path, "wx");
    if (owner !== "") writeSync(fd, owner);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
function atomicWrite(path, contents, mode) {
  const dir = dirname2(path);
  mkdir(dir);
  const tempPath = path + ".tmp-" + Math.random().toString(36).slice(2, 8);
  const target = mode ?? existingMode(path);
  if (target !== void 0) {
    writeFileSync2(tempPath, contents, { encoding: "utf-8", mode: target });
    chmodSync(tempPath, target);
  } else {
    writeFileSync2(tempPath, contents, "utf-8");
  }
  rename(tempPath, path);
}
function existingMode(path) {
  try {
    return statSync2(path).mode & 511;
  } catch {
    return void 0;
  }
}
function appendRecord(path, record, key, lockPath) {
  const escaped = record.replace(/\n/g, "\\n");
  const createErrorResult = (caught) => ({
    code: "E_APPEND_FAILED",
    // Informational: "check file permissions and disk space" is prose, not a runnable
    // command, and U10 admits only the latter under `Fix:`.
    kind: "informational",
    what: caught instanceof Error ? caught.message : String(caught),
    consequence: "Record was not appended"
  });
  if (escaped.length >= APPEND_ATOMIC_CEILING_BYTES) {
    try {
      lockPath(key, () => {
        mkdir(dirname2(path));
        const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW);
        try {
          writeSync(fd, escaped + "\n", null, "utf-8");
        } finally {
          closeSync(fd);
        }
      });
      return { ok: true };
    } catch (err) {
      const error = createErrorResult(err);
      logError(error);
      return { ok: false, error: "append_failed_with_lock" };
    }
  } else {
    mkdir(dirname2(path));
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW);
      try {
        writeSync(fd, escaped + "\n", null, "utf-8");
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (err) {
      const error = createErrorResult(err);
      logError(error);
      return { ok: false, error: "append_failed" };
    }
  }
}

export {
  mehmoryHome,
  codexHome,
  piSessionsDir,
  statePath,
  shellQuote,
  logError,
  failOpen,
  pendingWarnings,
  LOCK_RETRY_COUNT,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_STALE_MS,
  INDEX_LOCK_RETRY_COUNT,
  INDEX_LOCK_RETRY_INTERVAL_MS,
  QUEUE_CLAIM_ATTEMPTS,
  QUEUE_STALE_MS,
  readStdin,
  pathExists,
  stat,
  lstat,
  readFile,
  readFileFrom,
  readFileFromNoFollow,
  mkdir,
  rename,
  remove,
  removeDir,
  realpath,
  listDir,
  createLockExclusive,
  atomicWrite,
  appendRecord
};
