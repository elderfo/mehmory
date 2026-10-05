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
  writeFileSync,
  readdirSync,
  utimesSync
} from "fs";
import { dirname, join as join2 } from "path";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
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
  /** A store read or metadata probe failed; the caller uses an empty/unknown fallback. */
  E_STORE_READ: "informational",
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
  /** An unexpected CLI exception stopped the command; this is a bug, not an append failure. */
  E_INTERNAL: "informational",
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
var WARNING_CLAIM_STALE_MS = 60 * 1e3;
function warningPaths() {
  const paths = [];
  const legacy = statePath("warnings.json");
  if (existsSync(legacy)) paths.push(legacy);
  const dir = statePath("warning-records");
  try {
    paths.push(
      ...readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => join2(dir, name))
    );
  } catch {
  }
  for (const claimDir of [statePath(), dir]) {
    try {
      for (const name of readdirSync(claimDir)) {
        if (!/\.json(?:\.drain-[0-9a-f-]{36})+$/.test(name)) continue;
        if (claimDir !== dir && !name.startsWith("warnings.json.drain-")) continue;
        const path = join2(claimDir, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > WARNING_CLAIM_STALE_MS) paths.push(path);
        } catch {
        }
      }
    } catch {
    }
  }
  return paths;
}
function readWarnings(consume = false, limit = Infinity) {
  const selected = consume && Number.isFinite(limit) ? new Set(
    readWarnings().slice(0, Math.max(0, Math.floor(limit))).map((record) => record.code)
  ) : void 0;
  if (selected?.size === 0) return [];
  const records = [];
  for (const path of warningPaths()) {
    const claimed = consume ? `${path.replace(/(?:\.drain-[0-9a-f-]{36})+$/, "")}.drain-${randomUUID()}` : path;
    let renamed = false;
    if (consume) {
      try {
        renameSync(path, claimed);
        renamed = true;
        const now = /* @__PURE__ */ new Date();
        utimesSync(claimed, now, now);
      } catch (error) {
        if (error.code === "ENOENT") continue;
      }
    }
    const readPath = renamed ? claimed : path;
    try {
      const contents = readFileSync(readPath, "utf-8");
      let parsed;
      try {
        parsed = JSON.parse(contents);
      } catch {
        if (renamed) {
          try {
            unlinkSync(claimed);
          } catch {
          }
        }
        continue;
      }
      const valid = Array.isArray(parsed) ? parsed.filter(isWarningRecord) : isWarningRecord(parsed) ? [parsed] : [];
      const delivered = valid.filter(
        (record) => selected === void 0 || selected.has(record.code)
      );
      const remaining = valid.filter(
        (record) => selected !== void 0 && !selected.has(record.code)
      );
      if (renamed) {
        if (remaining.length > 0) {
          const dir = statePath("warning-records");
          mkdirSync(dir, { recursive: true });
          const temp = `${claimed}.tmp`;
          try {
            writeFileSync(temp, JSON.stringify(remaining), { flag: "wx" });
            renameSync(temp, join2(dir, `${randomUUID()}.json`));
          } finally {
            if (existsSync(temp)) unlinkSync(temp);
          }
        }
        unlinkSync(claimed);
      }
      records.push(...delivered);
    } catch {
      if (renamed) {
        try {
          renameSync(claimed, path);
        } catch {
        }
      }
    }
  }
  const warnings = /* @__PURE__ */ new Map();
  for (const record of records.sort((a, b) => a.lastTime - b.lastTime)) {
    const existing = warnings.get(record.code);
    if (!existing) warnings.set(record.code, { ...record });
    else if (record.lastTime - existing.lastTime >= WARN_RATE_LIMIT_MS) {
      existing.lastTime = record.lastTime;
      existing.count += record.count;
    }
  }
  return [...warnings.values()].sort((a, b) => a.code.localeCompare(b.code));
}
function recordWarning(code) {
  const dir = statePath("warning-records");
  const path = join2(dir, `${randomUUID()}.json`);
  const temp = `${path}.tmp`;
  try {
    const now = Date.now();
    const existing = readWarnings().find((w) => w.code === code);
    if (existing && now - existing.lastTime < WARN_RATE_LIMIT_MS) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify({ code, lastTime: now, count: 1 }), { flag: "wx" });
    renameSync(temp, path);
  } catch {
  } finally {
    try {
      unlinkSync(temp);
    } catch {
    }
  }
}
function warningLines(warnings) {
  return warnings.map((w) => {
    const kind = ERROR_KINDS[w.code] ?? "informational";
    return `${w.code} (${kind}, ${String(w.count)} occurrences): see ${statePath("errors.log")}`;
  });
}
function peekWarnings() {
  return warningLines(readWarnings());
}
function pendingWarnings(limit = Infinity) {
  return warningLines(readWarnings(true, limit));
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
  readdirSync as readdirSync2,
  rmSync,
  unlinkSync as unlinkSync2,
  realpathSync,
  chmodSync,
  fsyncSync,
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
function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function listDir(path) {
  return readdirSync2(path);
}
function createLockExclusive(path, owner = "", onError) {
  try {
    const fd = openSync(path, "wx");
    if (owner !== "") writeSync(fd, owner);
    closeSync(fd);
    return true;
  } catch (err) {
    onError?.(err);
    return false;
  }
}
function atomicWrite(path, contents, mode) {
  const dir = dirname2(path);
  mkdir(dir);
  const tempPath = path + ".tmp-" + Math.random().toString(36).slice(2, 8);
  const targetMode = mode ?? existingMode(path);
  let created = false;
  try {
    const fd = openSync(tempPath, "wx", targetMode);
    created = true;
    try {
      writeFileSync2(fd, contents, "utf-8");
      if (targetMode !== void 0) chmodSync(tempPath, targetMode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync2(tempPath, path);
    try {
      const directoryFd = openSync(dir, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
    }
  } catch (error) {
    if (created) {
      try {
        unlinkSync2(tempPath);
      } catch {
      }
    }
    throw error;
  }
}
function existingMode(path) {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() ? void 0 : info.mode & 511;
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
        const fd = openSync(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
        );
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
    try {
      mkdir(dirname2(path));
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
      );
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
  peekWarnings,
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
  realpath,
  listDir,
  createLockExclusive,
  atomicWrite,
  appendRecord
};
