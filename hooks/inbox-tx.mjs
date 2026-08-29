import {
  INBOX_HOSTS,
  appendInboxEntries,
  atomicWrite,
  clearInboxEntries,
  currentAgentName,
  inboxEntryId,
  loadConfig,
  pathExists,
  readFile,
  readInboxEntries,
  readSessionState,
  redact,
  remove,
  statePath
} from "./chunk-YEINRNIS.mjs";

// src/core/inbox-tx.ts
import { randomBytes } from "crypto";
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
  const inbox = requireString(input, "inbox");
  const key = requireString(input, "key");
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
  const inbox = requireString(input, "inbox");
  requireString(input, "key");
  const entries = readInboxEntries(inbox);
  const snapshotId = randomBytes(8).toString("hex");
  atomicWrite(
    snapshotFile(snapshotId),
    JSON.stringify({ inbox, ids: entries.map((e) => e.id) })
  );
  return { snapshotId, entries };
}
function doClear(input) {
  const inbox = requireString(input, "inbox");
  const key = requireString(input, "key");
  const path = snapshotFile(requireString(input, "snapshotId"));
  if (!pathExists(path)) throw new TxError("unknown snapshotId (already cleared?)");
  const stored = parseJsonRecord(readFile(path), "snapshot file");
  const ids = stored["ids"];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new TxError("corrupt snapshot file");
  }
  const result = clearInboxEntries(inbox, key, ids);
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
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(String(chunk)));
    process.stdin.on("end", () => {
      resolve(chunks.join(""));
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
