import {
  LOCK_RETRY_COUNT,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_STALE_MS,
  appendRecord,
  atomicWrite,
  createLockExclusive,
  failOpen,
  listDir,
  logError,
  lstat,
  mehmoryHome,
  mkdir,
  pathExists,
  readFile,
  realpath,
  remove,
  stat,
  statePath
} from "./chunk-2IVUMMAS.mjs";

// src/core/config.ts
import { join } from "path";

// src/schema/format.ts
import { createHash } from "crypto";

// src/core/agent-name.ts
var SAFE_AGENT_NAME = /^[a-z0-9._-]+$/;
var RESERVED_AGENT_NAMES = ["global", "projects", "agents", "all"];
var MAX_AGENT_NAME_LENGTH = 64;
function isSafeAgentName(name) {
  if (name.length === 0 || name.length > MAX_AGENT_NAME_LENGTH) return false;
  if (!SAFE_AGENT_NAME.test(name)) return false;
  if (name.startsWith(".")) return false;
  return !RESERVED_AGENT_NAMES.includes(name);
}

// src/schema/format.ts
var FRONTMATTER_DIVIDER = "---";
function readFrontmatter(contents) {
  const lines = contents.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DIVIDER) return {};
  const fields = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === FRONTMATTER_DIVIDER) break;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}
var MS_PER_DAY = 24 * 60 * 60 * 1e3;
function pageAgeDays(contents, now) {
  const updated = readFrontmatter(contents)["updated"];
  if (!updated) return null;
  const parsed = Date.parse(updated);
  return Number.isNaN(parsed) ? null : (now - parsed) / MS_PER_DAY;
}
var ARCHIVE_DIVIDER = "## Archive";
var ARCHIVE_DIR = "archive";
var STALE_SCORE_MULTIPLIER = 0.7;
function isStalePage(contents, now, staleAfterDays) {
  const age = pageAgeDays(contents, now);
  return age !== null && age > staleAfterDays;
}
var INDEX_LINE_PATTERN = /^\s*-\s+\[\[([^\]]+)\]\](?:\s+—\s*(.*))?$/;
function parseIndexLine(line) {
  const m = INDEX_LINE_PATTERN.exec(line.trimEnd());
  if (!m?.[1]) return void 0;
  return { slug: m[1], summary: m[2] ?? "" };
}
var INBOX_ENTRY_ID_LENGTH = 16;
var INBOX_HOSTS = ["claude-code", "codex", "pi"];
var DEFAULT_INBOX_HOST = "claude-code";
var INBOX_ENTRY_PATTERN = /^- (.*) <!--mehmory id=([0-9a-f]{16}) src=(\S*)(?: host=(\S+))?(?: agent=(\S*))? ts=(\S+)-->$/;
function inboxEntryId(seed) {
  return createHash("sha256").update(seed).digest("hex").slice(0, INBOX_ENTRY_ID_LENGTH);
}
function serializeInboxEntry(entry) {
  const text = entry.text.replace(/\r/g, "").replace(/\n/g, "\\n").replace(/--(!?)>/g, "--$1\\>").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(entry.src)) {
    throw new Error("inbox entry source contains unsafe metadata characters");
  }
  if (!/^[0-9a-f]{16}$/.test(entry.id) || Number.isNaN(Date.parse(entry.ts))) {
    throw new Error("inbox entry metadata is malformed");
  }
  const host = entry.host ?? DEFAULT_INBOX_HOST;
  const agent = entry.agent !== void 0 && isSafeAgentName(entry.agent) ? ` agent=${entry.agent}` : "";
  return `- ${text} <!--mehmory id=${entry.id} src=${entry.src} host=${host}${agent} ts=${entry.ts}-->`;
}
function parseInboxEntries(content) {
  const entries = [];
  for (const line of content.split("\n")) {
    const m = INBOX_ENTRY_PATTERN.exec(line.trimEnd());
    if (!m) continue;
    const [, text, id, src, rawHost, rawAgent, ts] = m;
    if (text === void 0 || id === void 0 || src === void 0 || ts === void 0) {
      continue;
    }
    const host = rawHost !== void 0 && INBOX_HOSTS.includes(rawHost) ? rawHost : DEFAULT_INBOX_HOST;
    const agent = rawAgent !== void 0 && isSafeAgentName(rawAgent) ? rawAgent : void 0;
    entries.push({
      id,
      text: text.replace(/--(!?)\\>/g, "--$1>").replace(/\\n/g, "\n"),
      src,
      host,
      ...agent !== void 0 ? { agent } : {},
      ts
    });
  }
  return entries;
}

// src/core/config.ts
var MAX_INJECTION_BUDGET_TOKENS = 8e3;
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
  hosts: {
    "claude-code": { enabled: true },
    codex: { enabled: true },
    pi: { enabled: true }
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
    aliases: {},
    agent: ""
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
  const configPath = join(home, "config.json");
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
  if (!isValidConfigShape(merged)) {
    logError(createConfigParseError("config.json contains values with invalid types."));
    return deepClone(DEFAULTS);
  }
  const secrets = merged["secrets"];
  if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
    merged["secrets"] = deepClone(DEFAULTS.secrets);
  } else {
    const secretConfig = secrets;
    if (!Array.isArray(secretConfig["patterns"])) secretConfig["patterns"] = [];
    if (!Array.isArray(secretConfig["whitelist"])) secretConfig["whitelist"] = [];
  }
  return merged;
}
var POLLUTING_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function isValidConfigShape(config) {
  const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const toggle = (value) => record(value) && typeof value["enabled"] === "boolean";
  const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const aliases = (value) => record(value) && Object.values(value).every((item) => typeof item === "string");
  const group = (name) => {
    const value = config[name];
    return record(value) ? value : void 0;
  };
  const injection = group("injection");
  const decay = group("decay");
  const secrets = group("secrets");
  const stop = group("stop");
  const hooks = group("hooks");
  const hosts = group("hosts");
  const inbox = group("inbox");
  const sessionState = group("session_state");
  const match = group("match");
  const identity = group("identity");
  const lock = group("lock");
  const queue = group("queue");
  const distill = group("distill");
  const log = group("log");
  const warning = group("warning");
  return injection !== void 0 && Number.isInteger(injection["budget_tokens"]) && injection["budget_tokens"] >= 1 && injection["budget_tokens"] <= MAX_INJECTION_BUDGET_TOKENS && decay !== void 0 && typeof decay["enabled"] === "boolean" && finite(decay["archive_days"]) && finite(decay["purge_days"]) && secrets !== void 0 && strings(secrets["patterns"]) && strings(secrets["whitelist"]) && stop !== void 0 && finite(stop["capture_threshold"]) && hooks !== void 0 && ["session_start", "user_prompt_submit", "stop", "pre_compact", "session_end"].every((key) => toggle(hooks[key])) && hosts !== void 0 && INBOX_HOSTS.every((host) => toggle(hosts[host])) && inbox !== void 0 && finite(inbox["nudge_entries"]) && finite(inbox["nudge_bytes"]) && sessionState !== void 0 && finite(sessionState["max_age_days"]) && match !== void 0 && finite(match["jaccard"]) && finite(match["cache_ttl_ms"]) && identity !== void 0 && aliases(identity["aliases"]) && typeof identity["agent"] === "string" && lock !== void 0 && finite(lock["retry_count"]) && finite(lock["retry_delay_ms"]) && finite(lock["stale_ms"]) && queue !== void 0 && finite(queue["max_claims"]) && finite(queue["stale_ms"]) && finite(queue["claims_per_start"]) && distill !== void 0 && finite(distill["max_loss_percent"]) && log !== void 0 && finite(log["rotation_size_mb"]) && warning !== void 0 && finite(warning["rate_limit_ms"]);
}
function deepMerge(target, source) {
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (POLLUTING_KEYS.has(key)) continue;
      const sourceValue = source[key];
      if (sourceValue !== null && typeof sourceValue === "object" && !Array.isArray(sourceValue) && // `hasOwnProperty`, not `in`: `in` walks the prototype chain, so an inherited
      // member would steer the recursion into a shared object rather than the config.
      Object.prototype.hasOwnProperty.call(target, key) && typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])) {
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

// src/core/agent.ts
function resolveAgentName(envValue, configValue) {
  if (envValue) return validated(envValue, "MEHMORY_AGENT");
  if (isAbsent(configValue)) return void 0;
  return validated(configValue, "config.identity.agent");
}
function isAbsent(value) {
  return value === void 0 || value === null || value === "";
}
function currentAgentName(config) {
  return resolveAgentName(process.env["MEHMORY_AGENT"], config.identity.agent);
}
function validated(value, source) {
  if (typeof value === "string" && isSafeAgentName(value)) return value;
  const shown = describe(value);
  logError({
    code: "E_AGENT_NAME_INVALID",
    kind: "actionable",
    what: `${source} is ${shown}, which is not a safe agent name`,
    consequence: "This agent is treated as unnamed and gets no agent scope",
    // Names every rule the value will actually be judged against: a fix a user can
    // follow and still be refused is worse than none.
    fix: `set ${source} to 1-64 chars of [a-z0-9._-], not starting with a dot, and not one of: ${RESERVED_AGENT_NAMES.join(", ")}`
  });
  return void 0;
}
function describe(value) {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

// src/core/lock.ts
import { createHash as createHash3, randomBytes } from "crypto";
import { join as join2 } from "path";

// src/core/identity.ts
import { execFileSync } from "child_process";
import { createHash as createHash2 } from "crypto";
var projectKeyCache = /* @__PURE__ */ new Map();
function configuredAlias(config, key) {
  const identity = config.identity;
  if (typeof identity !== "object" || identity === null) return void 0;
  const aliases = identity["aliases"];
  if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) return void 0;
  const alias = aliases[key];
  return typeof alias === "string" ? alias : void 0;
}
var SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function isContainedProjectKey(key) {
  const segments = key.split("/");
  if (segments.length === 0 || segments.length > 5) return false;
  return segments.every((seg) => seg !== "." && seg !== ".." && SAFE_SEGMENT.test(seg));
}
function isSafeProjectKey(key) {
  return key.includes("/") && isContainedProjectKey(key);
}
function safeRemoteKey(normalizedRemote) {
  if (isSafeProjectKey(normalizedRemote)) return normalizedRemote;
  const hash = createHash2("sha256").update(normalizedRemote).digest("hex").slice(0, 12);
  return `remote/${hash}`;
}
function resolveProjectKey(cwd = process.cwd()) {
  const cached = projectKeyCache.get(cwd);
  if (cached !== void 0) {
    return cached;
  }
  const rawRemoteKey = tryGetGitRemoteKey(cwd);
  if (rawRemoteKey) {
    const remoteKey = safeRemoteKey(rawRemoteKey);
    const config2 = loadConfig();
    const aliasKey2 = configuredAlias(config2, remoteKey);
    if (aliasKey2 !== void 0) {
      if (typeof aliasKey2 === "string" && isContainedProjectKey(aliasKey2)) {
        projectKeyCache.set(cwd, aliasKey2);
        return aliasKey2;
      }
    }
    projectKeyCache.set(cwd, remoteKey);
    return remoteKey;
  }
  const base = tryGetGitToplevel(cwd) ?? cwd;
  const resolvedPath = realpath(base);
  const hash = createHash2("sha256").update(resolvedPath).digest("hex").slice(0, 12);
  const pathKey = `local/${hash}`;
  const config = loadConfig();
  const aliasKey = configuredAlias(config, pathKey);
  if (aliasKey !== void 0) {
    if (isContainedProjectKey(aliasKey)) {
      projectKeyCache.set(cwd, aliasKey);
      return aliasKey;
    }
  }
  projectKeyCache.set(cwd, pathKey);
  return pathKey;
}
function tryGetGitToplevel(cwd) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe"
    }).trim();
    return top || void 0;
  } catch {
    return void 0;
  }
}
function tryGetGitRemoteKey(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "pipe" });
    const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe"
    }).trim();
    if (!remoteUrl) {
      return void 0;
    }
    return normalizeRemoteUrl(remoteUrl);
  } catch {
    return void 0;
  }
}
function normalizeRemoteUrl(url) {
  url = url.trim();
  if (url.endsWith(".git")) {
    url = url.slice(0, -4);
  }
  url = url.replace(/\/+$/, "");
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    return `${host ?? ""}/${path ?? ""}`;
  }
  const sshProtoMatch = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/u);
  if (sshProtoMatch) {
    const [, host, path] = sshProtoMatch;
    return `${host ?? ""}/${path ?? ""}`;
  }
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+)$/u);
  if (httpsMatch) {
    const [, host, path] = httpsMatch;
    return `${host ?? ""}/${path ?? ""}`;
  }
  return url;
}

// src/core/lock.ts
var LOCK_MAX_AGE_MS = 5 * 60 * 1e3;
var retryWait = new Int32Array(new SharedArrayBuffer(4));
var SESSION_LOCK_RETRY_COUNT = 10;
var SESSION_LOCK_RETRY_INTERVAL_MS = 20;
function lockFilePath(key) {
  const name = isContainedProjectKey(key) ? key.replace(/\//g, "_") : createHash3("sha256").update(key).digest("hex");
  return join2(statePath("locks"), name + ".lock");
}
function reclaimLock(path, observed, marker, owner) {
  const guardPath = `${path}.reclaim`;
  if (!createLockExclusive(guardPath, owner)) {
    const guardStat = stat(guardPath);
    if (!guardStat || Date.now() - Number(guardStat.mtimeMs) <= LOCK_STALE_MS) return false;
    if (!reclaimLock(guardPath, guardStat, readFile(guardPath), owner)) return false;
    if (!createLockExclusive(guardPath, owner)) return false;
  }
  try {
    const current = stat(path);
    if (!current || current.dev !== observed.dev || current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs || readFile(path) !== marker) {
      return false;
    }
    remove(path);
    return true;
  } finally {
    try {
      if (readFile(guardPath) === owner) remove(guardPath);
    } catch {
    }
  }
}
function withProjectLock(key, fn, retryCount = LOCK_RETRY_COUNT, retryIntervalMs = LOCK_RETRY_INTERVAL_MS, failOpen2 = true) {
  const lockPath = lockFilePath(key);
  let acquired = false;
  const owner = `${String(process.pid)}:${randomBytes(16).toString("hex")}`;
  try {
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      mkdir(statePath("locks"));
      if (createLockExclusive(lockPath, owner)) {
        acquired = true;
        break;
      }
      if (pathExists(lockPath)) {
        try {
          const lockStat = stat(lockPath);
          const now = Date.now();
          const mtime = Number(lockStat?.mtimeMs ?? now);
          const age = now - mtime;
          if (lockStat && age > LOCK_STALE_MS) {
            const marker = readFile(lockPath);
            const ownerPid = Number(marker.split(":", 1)[0]);
            let alive = false;
            if (age <= LOCK_MAX_AGE_MS && Number.isInteger(ownerPid) && ownerPid > 0) {
              try {
                process.kill(ownerPid, 0);
                alive = true;
              } catch (error) {
                alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
              }
            }
            if (!alive && reclaimLock(lockPath, lockStat, marker, owner)) continue;
          }
        } catch {
        }
      }
      if (attempt < retryCount) {
        Atomics.wait(retryWait, 0, 0, retryIntervalMs);
      }
    }
    if (!acquired) {
      const error = {
        code: "E_LOCK_TIMEOUT",
        kind: "informational",
        what: `project lock held for over ${String(retryCount * retryIntervalMs / 1e3)}s; ${failOpen2 ? "proceeded without it" : "skipped the operation"}`,
        consequence: failOpen2 ? "A concurrent session may have overwritten an index rewrite" : "The operation will be retried by a later hook"
      };
      logError(error);
      if (!failOpen2) return void 0;
    }
    return fn();
  } finally {
    if (acquired && pathExists(lockPath)) {
      try {
        if (readFile(lockPath) === owner) remove(lockPath);
      } catch {
      }
    }
  }
}
function tryProjectLock(key, fn) {
  const lockPath = lockFilePath(key);
  mkdir(statePath("locks"));
  const owner = `${String(process.pid)}:${randomBytes(16).toString("hex")}`;
  if (!createLockExclusive(lockPath, owner)) return void 0;
  try {
    return fn();
  } finally {
    if (pathExists(lockPath)) {
      try {
        if (readFile(lockPath) === owner) remove(lockPath);
      } catch {
      }
    }
  }
}
function withSessionLock(sessionId, fn) {
  return withProjectLock(
    `sessions/${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}`,
    fn,
    SESSION_LOCK_RETRY_COUNT,
    SESSION_LOCK_RETRY_INTERVAL_MS,
    false
  );
}

// src/core/inbox.ts
import { dirname, relative, resolve, sep } from "path";
function readInboxEntries(inboxFile) {
  return failOpen(
    () => pathExists(inboxFile) ? parseInboxEntries(readFile(inboxFile)) : [],
    [],
    "E_APPEND_FAILED"
  );
}
function isSafeInboxPath(inboxFile) {
  try {
    const home = realpath(resolve(mehmoryHome()));
    const parent = realpath(dirname(resolve(inboxFile)));
    const suffix = relative(home, parent);
    let symlink = false;
    try {
      symlink = lstat(resolve(inboxFile))?.isSymbolicLink() === true;
    } catch {
      symlink = false;
    }
    return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) ? !symlink : false;
  } catch {
    return false;
  }
}
function appendInboxEntries(inboxFile, entries, key) {
  return withProjectLock("__store__", () => appendInboxEntriesUnlocked(inboxFile, entries, key), 50, 100, false) ?? {
    appended: 0,
    skipped: 0,
    failed: entries.length
  };
}
function appendInboxEntriesUnlocked(inboxFile, entries, key) {
  if (!isSafeInboxPath(inboxFile)) return { appended: 0, skipped: 0, failed: entries.length };
  let appended = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of entries) {
    const serialized = serializeInboxEntry(entry);
    const result = withProjectLock(key, () => {
      const existing = new Set(readInboxEntries(inboxFile).map((e) => e.id));
      if (existing.has(entry.id)) return { kind: "skipped" };
      const append = appendRecord(inboxFile, serialized, key, (_key, fn) => {
        fn();
      });
      return append.ok ? { kind: "appended" } : { kind: "failed" };
    });
    if (result.kind === "appended") appended++;
    else if (result.kind === "failed") failed++;
    else skipped++;
  }
  return failed > 0 ? { appended, skipped, failed } : { appended, skipped };
}
function clearInboxEntries(inboxFile, key, ids) {
  const doomed = new Set(ids);
  if (doomed.size === 0) return { removed: 0 };
  if (!isSafeInboxPath(inboxFile)) return void 0;
  return tryProjectLock(
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
      void 0,
      "E_APPEND_FAILED"
    )
  );
}

// src/core/match.ts
import { basename, join as join3 } from "path";
var MIN_TOKEN_LENGTH = 3;
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "boy",
  "did",
  "use",
  "this",
  "that",
  "with",
  "from",
  "have",
  "they",
  "what",
  "when",
  "will",
  "your",
  "about",
  "would",
  "there",
  "their",
  "should",
  "could",
  "please",
  "need",
  "want",
  "make",
  "does",
  "into",
  "just",
  "like"
]);
function tokenize(text) {
  const tokens = /* @__PURE__ */ new Set();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
function countOccurrences(haystack, token) {
  let count = 0;
  let index = haystack.indexOf(token);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(token, index + token.length);
  }
  return count;
}
function matchPages(prompt, pagesDir, max = 3, options = {}) {
  const tokens = tokenize(prompt);
  if (tokens.size === 0 || !pathExists(pagesDir)) return [];
  const now = options.now ?? Date.now();
  const prefix = basename(pagesDir);
  const scored = [];
  for (const name of listDir(pagesDir)) {
    if (!name.endsWith(".md")) continue;
    const filePath = join3(pagesDir, name);
    let contents;
    try {
      if (!stat(filePath)?.isFile()) continue;
      contents = readFile(filePath);
    } catch {
      continue;
    }
    const stale = options.staleAfterDays !== void 0 && isStalePage(contents, now, options.staleAfterDays);
    const body = contents.toLowerCase();
    const titleLine = /^#\s+(.*)$/m.exec(body);
    const title = `${name.toLowerCase()} ${titleLine?.[1] ?? ""}`;
    let score = 0;
    for (const token of tokens) {
      score += countOccurrences(body, token) + 3 * countOccurrences(title, token);
    }
    if (score > 0) {
      scored.push({
        path: join3(prefix, name),
        score: stale ? score * STALE_SCORE_MULTIPLIER : score,
        stale
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, max).map((s) => ({ path: s.path, stale: s.stale }));
}

// src/core/session.ts
import { createHash as createHash4 } from "crypto";
import { join as join4 } from "path";

// src/core/cursor.ts
function freshCursor() {
  return { file_id: "", size: 0, offset: 0 };
}
function isCursorState(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v["file_id"] === "string" && typeof v["size"] === "number" && typeof v["offset"] === "number" && (v["last_hash"] === void 0 || typeof v["last_hash"] === "string");
}
function fileIdentity(filepath) {
  try {
    const s = stat(filepath);
    return { file_id: `${String(Number(s.dev))}:${String(Number(s.ino))}`, size: s.size };
  } catch {
    return null;
  }
}
function advanceCursor(current, filepath, recordHash, newOffset) {
  const identity = fileIdentity(filepath);
  const fileId = identity ? identity.file_id : current.file_id;
  const fileSize = identity ? identity.size : current.size;
  let offset = newOffset;
  if (current.file_id && current.file_id !== fileId) {
    offset = 0;
  } else if (current.offset > fileSize) {
    offset = 0;
  }
  return { file_id: fileId, size: fileSize, offset, last_hash: recordHash };
}

// src/core/session.ts
function sanitizeSessionId(sessionId) {
  return createHash4("sha256").update(sessionId).digest("hex");
}
function sessionStatePath(sessionId) {
  return statePath(`${sanitizeSessionId(sessionId)}.json`);
}
function freshSessionState(sessionId) {
  return { session_id: sessionId, cursor: freshCursor(), stop_count: 0, paused: false };
}
function parseSessionState(raw, sessionId) {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed;
  if (typeof v["session_id"] !== "string" || v["session_id"] !== sessionId) return null;
  if (!isCursorState(v["cursor"])) return null;
  if (typeof v["stop_count"] !== "number") return null;
  const topic = v["topic"];
  let topicCache;
  if (typeof topic === "object" && topic !== null) {
    const t = topic;
    if (Array.isArray(t["tokens"]) && typeof t["ts"] === "number") {
      topicCache = { tokens: t["tokens"].filter((x) => typeof x === "string"), ts: t["ts"] };
    }
  }
  const rawHost = v["host"];
  const host = typeof rawHost === "string" && INBOX_HOSTS.includes(rawHost) ? rawHost : void 0;
  return {
    session_id: sessionId,
    cursor: v["cursor"],
    stop_count: v["stop_count"],
    ...topicCache ? { topic: topicCache } : {},
    // `project_key` is read back from disk and handed straight to `scopePaths()`, which
    // joins it under `<home>/projects/`. The state file is a read boundary like the inbox
    // and the queue, so the key is re-validated here rather than trusted because the only
    // writer happens to sanitize. A rejected key is dropped, not repaired: the deferred
    // finalize then falls back to the sweeping session's key, which is wrong but in-store.
    ...typeof v["generation"] === "number" && Number.isInteger(v["generation"]) ? { generation: v["generation"] } : {},
    ...typeof v["project_key"] === "string" && isContainedProjectKey(v["project_key"]) ? { project_key: v["project_key"] } : {},
    ...typeof v["transcript_path"] === "string" ? { transcript_path: v["transcript_path"] } : {},
    ...host !== void 0 ? { host } : {},
    ...v["agent"] === null || typeof v["agent"] === "string" && isSafeAgentName(v["agent"]) ? { agent: v["agent"] } : {},
    paused: v["paused"] === true
  };
}
function readSessionState(sessionId) {
  const path = sessionStatePath(sessionId);
  if (!pathExists(path)) return freshSessionState(sessionId);
  try {
    const state = parseSessionState(readFile(path), sessionId);
    if (state) return state;
  } catch {
  }
  logError({
    code: "E_SESSION_STATE",
    kind: "informational",
    what: `session state for ${sessionId} was unreadable or malformed`,
    consequence: "Capture state reset to fresh; the transcript may be re-distilled once"
  });
  return freshSessionState(sessionId);
}
function writeSessionState(state) {
  atomicWrite(sessionStatePath(state.session_id), JSON.stringify(state));
}
function tryUpdateSessionState(sessionId, mutate) {
  return withSessionLock(sessionId, () => updateSessionStateUnlocked(sessionId, mutate));
}
function updateSessionStateUnlocked(sessionId, mutate) {
  if (!ensureSessionActiveUnlocked(sessionId)) return void 0;
  const next = mutate(readSessionState(sessionId));
  writeSessionState(next);
  return next;
}
function updateSessionState(sessionId, mutate) {
  return tryUpdateSessionState(sessionId, mutate) ?? readSessionState(sessionId);
}
function deleteSessionState(sessionId) {
  const path = sessionStatePath(sessionId);
  if (!pathExists(path)) return;
  try {
    remove(path);
  } catch {
  }
}
function finalizedMarkerPath(sessionId) {
  return statePath(`${sanitizeSessionId(sessionId)}.finalized.json`);
}
function isSessionFinalized(sessionId) {
  return pathExists(finalizedMarkerPath(sessionId));
}
function markSessionFinalized(sessionId, cursor, generation = 0, origin) {
  atomicWrite(
    finalizedMarkerPath(sessionId),
    JSON.stringify({
      session_id: sessionId,
      generation,
      ...cursor ? { cursor } : {},
      transcript_path: origin?.transcript_path,
      host: origin?.host,
      project_key: origin?.project_key,
      agent: origin?.agent,
      paused: origin?.paused
    })
  );
}
function sessionGeneration(sessionId) {
  return readSessionState(sessionId).generation ?? 0;
}
function resumeFinalizedSession(sessionId) {
  return withSessionLock(sessionId, () => resumeFinalizedSessionUnlocked(sessionId)) ?? false;
}
function ensureSessionActiveUnlocked(sessionId, transcriptPath) {
  return !isSessionFinalized(sessionId) || resumeFinalizedSessionUnlocked(sessionId, true, transcriptPath);
}
function resumeFinalizedSessionUnlocked(sessionId, requireActivity = false, transcriptPath) {
  const marker = finalizedMarkerPath(sessionId);
  if (!pathExists(marker)) return false;
  let cursor;
  let generation = 0;
  let savedState = freshSessionState(sessionId);
  try {
    const parsed = JSON.parse(readFile(marker));
    if (typeof parsed === "object" && parsed !== null) {
      const raw = parsed["cursor"];
      if (isCursorState(raw)) cursor = raw;
      const gen = parsed["generation"];
      if (typeof gen === "number" && Number.isInteger(gen)) generation = gen;
      savedState = parseSessionState(
        JSON.stringify({
          ...parsed,
          session_id: sessionId,
          cursor: cursor ?? freshCursor(),
          stop_count: 0,
          paused: requireActivity && parsed["paused"] === true
        }),
        sessionId
      ) ?? savedState;
    }
  } catch {
  }
  if (requireActivity) {
    const transcript = transcriptPath ?? savedState.transcript_path;
    try {
      if (!transcript || !pathExists(transcript)) return false;
      const info = stat(transcript);
      if (info?.isFile() !== true) return false;
      const active = cursor !== void 0 && cursor.file_id !== "" ? info.size > Math.max(cursor.offset, cursor.size) : info.mtimeMs > (stat(marker)?.mtimeMs ?? Infinity);
      if (!active) return false;
    } catch {
      return false;
    }
  }
  const current = readSessionState(sessionId);
  const next = Math.max(generation, current.generation ?? 0) + 1;
  const nextState = pathExists(sessionStatePath(sessionId)) ? { ...current, generation: next } : { ...savedState, generation: next };
  let markerRemoved = false;
  try {
    remove(marker);
    markerRemoved = true;
    writeSessionState(nextState);
  } catch {
    if (markerRemoved) {
      try {
        markSessionFinalized(sessionId, cursor, generation, savedState);
      } catch {
      }
    }
    return false;
  }
  return true;
}
function rememberSessionOrigin(sessionId, transcriptPath, host, projectKey, agent) {
  if (transcriptPath === void 0 || transcriptPath === "") return;
  withSessionLock(sessionId, () => {
    if (!ensureSessionActiveUnlocked(sessionId, transcriptPath)) return;
    const state = readSessionState(sessionId);
    if (state.transcript_path === transcriptPath && state.host === host && state.project_key === projectKey && state.agent === (agent ?? null)) {
      return;
    }
    writeSessionState({
      ...state,
      transcript_path: transcriptPath,
      host,
      project_key: projectKey,
      agent: agent ?? null
    });
  });
}
var PENDING_FINALIZE_IDLE_MS = 30 * 60 * 1e3;
function listPendingSessions(idleMs = PENDING_FINALIZE_IDLE_MS) {
  const dir = statePath();
  if (!pathExists(dir)) return [];
  const cutoff = Date.now() - idleMs;
  const pending = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".finalized.json")) continue;
    try {
      const path = join4(dir, name);
      const mtime = stat(path)?.mtimeMs;
      const raw = readFile(path);
      const id = JSON.parse(raw)["session_id"];
      if (typeof id !== "string" || id.trim() === "") continue;
      const state = parseSessionState(raw, id);
      if (!state || state.transcript_path === void 0) continue;
      if (isSessionFinalized(id)) continue;
      if (mtime === void 0 || mtime > cutoff) continue;
      if (pathExists(state.transcript_path)) {
        const transcriptMtime = stat(state.transcript_path)?.mtimeMs;
        if (transcriptMtime !== void 0 && transcriptMtime > cutoff) continue;
      }
      pending.push(state);
    } catch {
    }
  }
  return pending;
}
function isSweepableState(path) {
  if (!pathExists(path)) return false;
  try {
    const parsed = JSON.parse(readFile(path));
    if (typeof parsed !== "object" || parsed === null) return false;
    return typeof parsed["session_id"] === "string";
  } catch {
    return false;
  }
}
function sweepSessionState(maxAgeDays) {
  const days = maxAgeDays ?? loadConfig().session_state.max_age_days;
  const dir = statePath();
  if (!pathExists(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3;
  let deleted = 0;
  for (const name of listDir(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join4(dir, name);
    try {
      const mtime = stat(path)?.mtimeMs;
      if (mtime === void 0 || mtime > cutoff) continue;
      const parsed = JSON.parse(readFile(path));
      if (typeof parsed !== "object" || parsed === null) continue;
      const id = parsed["session_id"];
      if (typeof id !== "string") continue;
      if (name.endsWith(".finalized.json") && isSweepableState(sessionStatePath(id))) continue;
      remove(path);
      deleted++;
    } catch {
    }
  }
  return deleted;
}
function advanceSessionCursorUnlocked(sessionId, filepath, recordHash, newOffset) {
  return updateSessionStateUnlocked(sessionId, (state) => ({
    ...state,
    cursor: advanceCursor(state.cursor, filepath, recordHash, newOffset)
  }))?.cursor;
}
function incrementStopCount(sessionId) {
  return updateSessionState(sessionId, (s) => ({ ...s, stop_count: s.stop_count + 1 })).stop_count;
}
function resetStopCount(sessionId) {
  updateSessionState(sessionId, (s) => ({ ...s, stop_count: 0 }));
}
function topicCacheHit(state, tokens, now = Date.now(), thresholds) {
  if (!state.topic) return false;
  const cfg = thresholds ?? {
    jaccard: loadConfig().match.jaccard,
    ttlMs: loadConfig().match.cache_ttl_ms
  };
  if (now - state.topic.ts > cfg.ttlMs) return false;
  return jaccard(new Set(state.topic.tokens), tokens) >= cfg.jaccard;
}
function rememberTopic(sessionId, tokens, now = Date.now()) {
  updateSessionState(sessionId, (s) => ({ ...s, topic: { tokens: [...tokens], ts: now } }));
}
function setPaused(sessionId, paused) {
  return tryUpdateSessionState(sessionId, (s) => ({ ...s, paused })) !== void 0;
}
function isPaused(sessionId) {
  return readSessionState(sessionId).paused;
}

// src/core/redact.ts
import { join as join5 } from "path";
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
  const boundedPatterns = patterns.slice(0, 64).filter((raw) => raw.length <= 512);
  const cacheKey = JSON.stringify(boundedPatterns);
  const cached = userPatternCache.get(cacheKey);
  if (cached) return cached;
  const compiled = [];
  for (const raw of boundedPatterns) {
    const parsed = /^\/(.*)\/([a-z]*)$/s.exec(raw);
    try {
      if (!parsed?.[1]) throw new Error("not in /source/flags form");
      if (parsed[1].length > 256 || (parsed[1].match(/[+*]|\\{\d+(?:,\d*)?}/g)?.length ?? 0) > 3 || /\\[1-9]|\([^()]*[+*{][^)]*\)[+*{]/.test(parsed[1]) || /\([^()]*\|[^()]*\)[+*]/.test(parsed[1]) || /\(\?<?[=!]/.test(parsed[1])) {
        throw new Error("pattern is too complex or too long");
      }
      const flags = parsed[2] ?? "";
      compiled.push(new RegExp(parsed[1], flags.includes("g") ? flags : flags + "g"));
    } catch (err) {
      logError({
        code: "E_CONFIG_PARSE",
        kind: "actionable",
        what: `secrets.patterns entry ${String(patterns.indexOf(raw))} is not a usable regex (${err instanceof Error ? err.message : String(err)})`,
        consequence: "That pattern is skipped; the built-in secret patterns still apply",
        fix: `$EDITOR ${join5(mehmoryHome(), "config.json")}`
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
    const candidate = options;
    const patterns = Array.isArray(candidate.patterns) ? candidate.patterns.filter((entry) => typeof entry === "string") : [];
    const whitelist = Array.isArray(candidate.whitelist) ? candidate.whitelist.filter(
      (entry) => typeof entry === "string" && entry !== ""
    ) : [];
    const extra = compileUserPatterns(patterns);
    return applyPatterns(text, extra, whitelist);
  } catch {
    return text;
  }
}

export {
  isSafeAgentName,
  readFrontmatter,
  pageAgeDays,
  ARCHIVE_DIVIDER,
  ARCHIVE_DIR,
  parseIndexLine,
  INBOX_HOSTS,
  inboxEntryId,
  MAX_INJECTION_BUDGET_TOKENS,
  loadConfig,
  currentAgentName,
  isContainedProjectKey,
  resolveProjectKey,
  withProjectLock,
  tryProjectLock,
  withSessionLock,
  readInboxEntries,
  appendInboxEntries,
  clearInboxEntries,
  redact,
  tokenize,
  matchPages,
  sessionStatePath,
  readSessionState,
  deleteSessionState,
  isSessionFinalized,
  markSessionFinalized,
  sessionGeneration,
  resumeFinalizedSession,
  ensureSessionActiveUnlocked,
  rememberSessionOrigin,
  listPendingSessions,
  sweepSessionState,
  advanceSessionCursorUnlocked,
  incrementStopCount,
  resetStopCount,
  topicCacheHit,
  rememberTopic,
  setPaused,
  isPaused
};
