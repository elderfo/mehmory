import {
  INBOX_HOSTS,
  appendInboxEntries,
  atomicWrite,
  clearInboxEntries,
  currentAgentName,
  inboxEntryId,
  isContainedProjectKey,
  loadConfig,
  lstat,
  mehmoryHome,
  pathExists,
  readFile,
  readInboxEntries,
  readSessionState,
  realpath,
  redact,
  remove,
  statePath
} from "./chunk-HNC6COVE.mjs";

// src/core/inbox-tx.ts
import { randomBytes } from "crypto";
import { basename, dirname, relative, resolve, sep } from "path";
var TxError = class extends Error {
};
function asRecord(value, what) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TxError(`${what} must be a JSON object`);
  }
  return value;
}
function parseJsonRecord(raw, what) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TxError(`${what} is not valid JSON`);
  }
  return asRecord(parsed, what);
}
function requireString(input, field) {
  const value = input[field];
  if (typeof value !== "string" || value === "") {
    throw new TxError(`missing or empty "${field}"`);
  }
  return value;
}
function snapshotFile(snapshotId) {
  if (!/^[0-9a-f]{16}$/.test(snapshotId)) {
    throw new TxError(`malformed snapshotId "${snapshotId}"`);
  }
  return statePath(`inbox-snapshot.${snapshotId}.json`);
}
function validateInbox(input) {
  const inbox = requireString(input, "inbox");
  const key = requireString(input, "key");
  const home = resolve(mehmoryHome());
  const candidate = resolve(inbox);
  const within = (root, path) => {
    const suffix = relative(root, path);
    return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`);
  };
  if (!within(home, candidate) || basename(candidate) !== "inbox.md") {
    throw new TxError('"inbox" must be an inbox.md inside MEHMORY_HOME');
  }
  try {
    if (lstat(candidate)?.isSymbolicLink()) {
      throw new TxError('"inbox" must not be a symlink');
    }
  } catch (err) {
    if (err instanceof TxError) throw err;
  }
  const homeReal = realpath(home);
  const targetReal = realpath(candidate);
  const parentReal = realpath(dirname(candidate));
  if (!within(homeReal, targetReal) || !within(homeReal, parentReal) || pathExists(candidate) && targetReal !== candidate) {
    throw new TxError('"inbox" must not resolve outside MEHMORY_HOME');
  }
  if (key === "global" && candidate !== resolve(home, "global", "inbox.md") && candidate !== resolve(home, "inbox.md")) {
    throw new TxError('"key" does not match "inbox"');
  }
  if (key !== "global") {
    const projects = resolve(home, "projects");
    if (!within(projects, candidate)) throw new TxError('"key" does not match "inbox"');
    const actual = relative(projects, dirname(candidate)).split(sep).join("/");
    if (actual !== key || !isContainedProjectKey(key)) {
      throw new TxError('"key" does not match "inbox"');
    }
  }
  if (!within(homeReal, targetReal)) {
    throw new TxError('"inbox" must resolve inside MEHMORY_HOME');
  }
  return { inbox: candidate, key };
}
function declaredHost(input) {
  const value = input["host"];
  if (value === void 0) return void 0;
  if (typeof value !== "string" || !INBOX_HOSTS.includes(value)) {
    throw new TxError(`unknown "host" (expected ${INBOX_HOSTS.join("|")})`);
  }
  return value;
}
function rejectDeclaredAgent(input, where) {
  if (input["agent"] !== void 0) {
    throw new TxError(`"agent" cannot be declared${where}; it comes from MEHMORY_AGENT`);
  }
}
function doAppend(input, config) {
  const { inbox, key } = validateInbox(input);
  const raw = input["entries"];
  if (!Array.isArray(raw)) throw new TxError('"entries" must be an array');
  const host = declaredHost(input);
  rejectDeclaredAgent(input, "");
  const agent = currentAgentName(config);
  const secrets = config.secrets;
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const entries = raw.map((item, i) => {
    const entry = asRecord(item, `entries[${String(i)}]`);
    rejectDeclaredAgent(entry, ` on entries[${String(i)}]`);
    const text = redact(requireString(entry, "text"), secrets);
    const src = requireString(entry, "src");
    if (!/^[A-Za-z0-9._:-]+$/.test(src)) {
      throw new TxError('"src" contains unsafe comment characters');
    }
    const entryHost = host ?? readSessionState(src).host;
    return {
      id: inboxEntryId(src + text),
      text,
      src,
      ...entryHost !== void 0 ? { host: entryHost } : {},
      ...agent !== void 0 ? { agent } : {},
      ts
    };
  });
  return appendInboxEntries(inbox, entries, key);
}
function doSnapshot(input) {
  const { inbox, key } = validateInbox(input);
  const entries = readInboxEntries(inbox);
  const snapshotId = randomBytes(8).toString("hex");
  atomicWrite(
    snapshotFile(snapshotId),
    JSON.stringify({ inbox, key, ids: entries.map((e) => e.id) })
  );
  return { snapshotId, entries };
}
function doClear(input) {
  const { inbox, key } = validateInbox(input);
  const path = snapshotFile(requireString(input, "snapshotId"));
  if (!pathExists(path)) throw new TxError("unknown snapshotId (already cleared?)");
  const stored = parseJsonRecord(readFile(path), "snapshot file");
  const ids = stored["ids"];
  if (stored["inbox"] !== inbox || stored["key"] !== key || !Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new TxError("snapshot does not match the requested inbox");
  }
  const result = clearInboxEntries(inbox, key, ids);
  if (result === void 0) throw new TxError("inbox is busy; retry the same snapshot");
  remove(path);
  return result;
}
function runInboxTx(subcommand, input, config) {
  switch (subcommand) {
    case "append":
      return doAppend(input, config);
    case "snapshot":
      return doSnapshot(input);
    case "clear":
      return doClear(input);
    default:
      throw new TxError(`unknown subcommand "${subcommand}" (expected append|snapshot|clear)`);
  }
}

// src/hooks/inbox-tx.ts
function readStdin() {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(String(chunk)));
    process.stdin.on("end", () => {
      resolve2(chunks.join(""));
    });
    process.stdin.on("error", reject);
  });
}
async function main() {
  const subcommand = process.argv[2] ?? "";
  const stdin = await readStdin();
  const input = parseJsonRecord(stdin, "stdin");
  const result = runInboxTx(subcommand, input, loadConfig());
  process.stdout.write(JSON.stringify(result) + "\n");
}
try {
  await main();
} catch (err) {
  process.stderr.write(`inbox-tx: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
}
