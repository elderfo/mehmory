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
  E_PURGE_FAILED: "actionable"
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
  appendFileSync as appendFileSync2,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fstatSync,
  existsSync as existsSync2,
  statSync as statSync2,
  renameSync as renameSync2,
  mkdirSync as mkdirSync2,
  readdirSync,
  rmSync,
  unlinkSync as unlinkSync2,
  realpathSync
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
  return readdirSync(path);
}
function createLockExclusive(path) {
  try {
    const fd = openSync(path, "wx");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
function atomicWrite(path, contents) {
  const dir = dirname2(path);
  mkdir(dir);
  const tempPath = path + ".tmp-" + Math.random().toString(36).slice(2, 8);
  writeFileSync2(tempPath, contents, "utf-8");
  rename(tempPath, path);
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
        appendFileSync2(path, escaped + "\n", "utf-8");
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
      const fd = openSync(path, "a");
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

// src/core/config.ts
import { join as join2 } from "path";
var DEFAULTS = {
  injection: {
    budget_tokens: 800
  },
  decay: {
    enabled: true,
    archive_days: 60,
    purge_days: 90
  },
  secrets: {
    patterns: [
      // AWS keys: AKIA... or similar
      /AKIA[0-9A-Z]{16}/,
      // GitHub tokens: ghp_ or ghs_ or ghu_ or gho_
      /gh[psuor]_[A-Za-z0-9_]{36,255}/,
      // Generic bearer tokens
      /bearer\s+[A-Za-z0-9._-]{20,}/i,
      // Private key blocks
      /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/,
      // .env-shaped KEY=value
      /^[A-Z_][A-Z0-9_]*=.+$/m
    ].map((p) => p.toString()),
    whitelist: []
  },
  stop: {
    capture_threshold: 15
  },
  hooks: {
    session_start: { enabled: true },
    user_prompt_submit: { enabled: true },
    stop: { enabled: true },
    pre_compact: { enabled: true },
    session_end: { enabled: true }
  },
  inbox: {
    nudge_entries: 10,
    nudge_bytes: 8192
  },
  session_state: {
    max_age_days: 14
  },
  match: {
    jaccard: 0.7,
    cache_ttl_ms: 3e5
  },
  identity: {
    aliases: {}
  },
  lock: {
    retry_count: 50,
    retry_delay_ms: 100,
    stale_ms: 3e4
  },
  queue: {
    max_claims: 3,
    stale_ms: 3e4,
    claims_per_start: 1
  },
  distill: {
    max_loss_percent: 10
  },
  log: {
    rotation_size_mb: 5
  },
  warning: {
    rate_limit_ms: 36e5
    // 1 hour
  }
};
function loadConfig() {
  const home = mehmoryHome();
  const configPath = join2(home, "config.json");
  if (!pathExists(configPath)) {
    return deepClone(DEFAULTS);
  }
  const createConfigParseError = (what) => ({
    code: "E_CONFIG_PARSE",
    kind: "actionable",
    what,
    consequence: "Memory is running on defaults, so your settings are not applied.",
    fix: `$EDITOR ${configPath}`
  });
  let userConfig;
  try {
    const content = readFile(configPath);
    userConfig = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(createConfigParseError(`config.json is not valid JSON (${message}).`));
    return deepClone(DEFAULTS);
  }
  if (typeof userConfig !== "object" || userConfig === null) {
    logError(createConfigParseError("config.json root is not an object."));
    return deepClone(DEFAULTS);
  }
  const merged = deepMerge(
    deepClone(DEFAULTS),
    userConfig
  );
  return merged;
}
function deepMerge(target, source) {
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      if (sourceValue !== null && typeof sourceValue === "object" && !Array.isArray(sourceValue) && key in target && typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])) {
        deepMerge(
          target[key],
          sourceValue
        );
      } else {
        target[key] = sourceValue;
      }
    }
  }
  return target;
}
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => deepClone(item));
  }
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  const cloned = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}

// src/core/lock.ts
import { join as join3 } from "path";
function lockFilePath(key) {
  return join3(statePath("locks"), key.replace(/\//g, "_") + ".lock");
}
function withProjectLock(key, fn, retryCount = LOCK_RETRY_COUNT, retryIntervalMs = LOCK_RETRY_INTERVAL_MS) {
  const lockPath = lockFilePath(key);
  mkdir(join3(mehmoryHome(), ".state", "locks"));
  let acquired = false;
  try {
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      if (createLockExclusive(lockPath)) {
        acquired = true;
        break;
      }
      if (pathExists(lockPath)) {
        try {
          const lockStat = stat(lockPath);
          if (!lockStat) {
            if (attempt < retryCount) {
              const end = Date.now() + retryIntervalMs;
              while (Date.now() < end) {
              }
            }
            continue;
          }
          const now = Date.now();
          const mtime = typeof lockStat.mtimeMs === "number" ? lockStat.mtimeMs : 0;
          const age = now - mtime;
          if (age > LOCK_STALE_MS) {
            try {
              remove(lockPath);
              continue;
            } catch {
            }
          }
        } catch {
        }
      }
      if (attempt < retryCount) {
        const end = Date.now() + retryIntervalMs;
        while (Date.now() < end) {
        }
      }
    }
    if (!acquired) {
      const error = {
        code: "E_LOCK_TIMEOUT",
        kind: "informational",
        what: `project lock held for over ${String(retryCount * retryIntervalMs / 1e3)}s; proceeded without it`,
        consequence: "A concurrent session may have overwritten an index rewrite"
      };
      logError(error);
    }
    return fn();
  } finally {
    if (acquired && pathExists(lockPath)) {
      try {
        remove(lockPath);
      } catch {
      }
    }
  }
}
function tryProjectLock(key, fn) {
  const lockPath = lockFilePath(key);
  mkdir(join3(mehmoryHome(), ".state", "locks"));
  if (!createLockExclusive(lockPath)) return void 0;
  try {
    return fn();
  } finally {
    if (pathExists(lockPath)) {
      try {
        remove(lockPath);
      } catch {
      }
    }
  }
}

// src/schema/format.ts
import { createHash as createHash2 } from "crypto";
var FRONTMATTER_DIVIDER = "---";
var ARCHIVE_DIVIDER = "## Archive";
var ARCHIVE_DIR = "archive";
var INDEX_LINE_PATTERN = /^\s*-\s+\[\[([^\]]+)\]\](?:\s+—\s*(.*))?$/;
function parseIndexLine(line) {
  const m = INDEX_LINE_PATTERN.exec(line.trimEnd());
  if (!m?.[1]) return void 0;
  return { slug: m[1], summary: m[2] ?? "" };
}
var INBOX_ENTRY_ID_LENGTH = 16;
var INBOX_ENTRY_PATTERN = /^- (.*) <!--mehmory id=([0-9a-f]{16}) src=(\S*) ts=(\S+)-->$/;
function inboxEntryId(seed) {
  return createHash2("sha256").update(seed).digest("hex").slice(0, INBOX_ENTRY_ID_LENGTH);
}
function serializeInboxEntry(entry) {
  const text = entry.text.replace(/\r/g, "").replace(/\n/g, "\\n").replace(/-->/g, "--\\>").trim();
  return `- ${text} <!--mehmory id=${entry.id} src=${entry.src} ts=${entry.ts}-->`;
}
function parseInboxEntries(content) {
  const entries = [];
  for (const line of content.split("\n")) {
    const m = INBOX_ENTRY_PATTERN.exec(line.trimEnd());
    if (!m) continue;
    const [, text, id, src, ts] = m;
    if (text === void 0 || id === void 0 || src === void 0 || ts === void 0) {
      continue;
    }
    entries.push({
      id,
      text: text.replace(/--\\>/g, "-->").replace(/\\n/g, "\n"),
      src,
      ts
    });
  }
  return entries;
}

// src/core/inbox.ts
function readInboxEntries(inboxFile) {
  return failOpen(
    () => pathExists(inboxFile) ? parseInboxEntries(readFile(inboxFile)) : [],
    [],
    "E_APPEND_FAILED"
  );
}
function appendInboxEntries(inboxFile, entries, key) {
  const existing = new Set(readInboxEntries(inboxFile).map((e) => e.id));
  let appended = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (existing.has(entry.id)) {
      skipped++;
      continue;
    }
    const result = appendRecord(inboxFile, serializeInboxEntry(entry), key, withProjectLock);
    if (result.ok) {
      existing.add(entry.id);
      appended++;
    } else {
      skipped++;
    }
  }
  return { appended, skipped };
}
function clearInboxEntries(inboxFile, key, ids) {
  const doomed = new Set(ids);
  if (doomed.size === 0) return { removed: 0 };
  return withProjectLock(
    key,
    () => failOpen(
      () => {
        if (!pathExists(inboxFile)) return { removed: 0 };
        const lines = readFile(inboxFile).split("\n");
        const kept = [];
        let removed = 0;
        for (const line of lines) {
          const [entry] = parseInboxEntries(line);
          if (entry && doomed.has(entry.id)) {
            removed++;
            continue;
          }
          kept.push(line);
        }
        if (removed > 0) atomicWrite(inboxFile, kept.join("\n"));
        return { removed };
      },
      { removed: 0 },
      "E_APPEND_FAILED"
    )
  );
}

// src/core/redact.ts
import { join as join4 } from "path";
var REDACTION_PLACEHOLDER = "[REDACTED]";
var SECRET_PATTERNS = [
  // AWS: AKIA... access keys (20 chars after AKIA)
  /AKIA[0-9A-Z]{16}/gi,
  // AWS: secret access keys (40 chars, base64-like)
  /aws_secret_access_key\s*=\s*([A-Za-z0-9/+=]{40})/gi,
  // GitHub: ghp_ personal access tokens (36 chars after ghp_)
  /ghp_[A-Za-z0-9_]{36}/gi,
  // GitHub: ghs_ OAuth tokens (37 chars after ghs_)
  /ghs_[A-Za-z0-9_]{37}/gi,
  // GitHub: ghu_ user tokens (37 chars after ghu_)
  /ghu_[A-Za-z0-9_]{37}/gi,
  // Generic bearer token: Bearer <token> (assumes token is 32+ chars of non-space)
  /bearer\s+[A-Za-z0-9._-]{32,}/gi,
  // Private key blocks: -----BEGIN...-----END
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
  // .env-style KEY=value (requires KEY to be UPPERCASE_WORD and value to be non-empty, non-quoted)
  // Excludes lines like PATH=/usr/bin, common env vars
  /^([A-Z][A-Z0-9_]*(?<!PATH|HOME|USER|SHELL|LANG|TERM))\s*=\s*([^\s'"]+)$/gm,
  // URL-embedded credentials: scheme://user:pass@host
  // eslint-disable-next-line no-useless-escape
  /(?:https?|ftp|ssh):\/\/[A-Za-z0-9._%-]+:[A-Za-z0-9!@#$%^&*()_+=\[\]{}|;':",./<>?-]{1,}@/gi,
  // API keys (APIKEY=... or api_key=..., common pattern)
  /(api[_-]?key|apikey)\s*=\s*([A-Za-z0-9_-]{20,})/gi,
  // Tokens in common formats: token=..., access_token=...
  /(access[_-]?token|token|auth[_-]?token)\s*=\s*([A-Za-z0-9_-]{20,})/gi
];
var userPatternCache = /* @__PURE__ */ new Map();
function compileUserPatterns(patterns) {
  const cacheKey = JSON.stringify(patterns);
  const cached = userPatternCache.get(cacheKey);
  if (cached) return cached;
  const compiled = [];
  for (const raw of patterns) {
    const parsed = /^\/(.*)\/([a-z]*)$/s.exec(raw);
    try {
      if (!parsed?.[1]) throw new Error("not in /source/flags form");
      const flags = parsed[2] ?? "";
      compiled.push(new RegExp(parsed[1], flags.includes("g") ? flags : flags + "g"));
    } catch (err) {
      logError({
        code: "E_CONFIG_PARSE",
        kind: "actionable",
        what: `secrets.patterns entry ${JSON.stringify(raw)} is not a usable regex (${err instanceof Error ? err.message : String(err)})`,
        consequence: "That pattern is skipped; the built-in secret patterns still apply",
        fix: `$EDITOR ${join4(mehmoryHome(), "config.json")}`
      });
    }
  }
  userPatternCache.set(cacheKey, compiled);
  return compiled;
}
function whitelistRanges(text, whitelist) {
  const ranges = [];
  for (const literal of whitelist) {
    let from = text.indexOf(literal);
    while (from !== -1) {
      ranges.push([from, from + literal.length]);
      from = text.indexOf(literal, from + 1);
    }
  }
  return ranges;
}
function isExempt(start, end, ranges) {
  return ranges.some(([from, to]) => from <= start && end <= to);
}
function applyPatterns(text, extra, whitelist) {
  let result = text;
  for (const pattern of [...SECRET_PATTERNS, ...extra]) {
    pattern.lastIndex = 0;
    if (whitelist.length === 0) {
      result = result.replace(pattern, REDACTION_PLACEHOLDER);
      continue;
    }
    const ranges = whitelistRanges(result, whitelist);
    result = result.replace(pattern, (...args) => {
      const match = String(args[0]);
      const offset = Number(args[args.length - 2]);
      return isExempt(offset, offset + match.length, ranges) ? match : REDACTION_PLACEHOLDER;
    });
  }
  return result;
}
function redact(text, options = {}) {
  if (!text || typeof text !== "string") {
    return text ?? "";
  }
  try {
    const extra = options.patterns ? compileUserPatterns(options.patterns) : [];
    const whitelist = (options.whitelist ?? []).filter((entry) => entry !== "");
    return applyPatterns(text, extra, whitelist);
  } catch {
    return text;
  }
}

export {
  mehmoryHome,
  statePath,
  logError,
  failOpen,
  pendingWarnings,
  INDEX_LOCK_RETRY_COUNT,
  INDEX_LOCK_RETRY_INTERVAL_MS,
  QUEUE_CLAIM_ATTEMPTS,
  QUEUE_STALE_MS,
  readStdin,
  pathExists,
  stat,
  readFile,
  readFileFrom,
  mkdir,
  rename,
  remove,
  realpath,
  listDir,
  atomicWrite,
  appendRecord,
  loadConfig,
  withProjectLock,
  tryProjectLock,
  FRONTMATTER_DIVIDER,
  ARCHIVE_DIVIDER,
  ARCHIVE_DIR,
  parseIndexLine,
  inboxEntryId,
  readInboxEntries,
  appendInboxEntries,
  clearInboxEntries,
  redact
};
