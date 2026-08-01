import {
  appendInboxEntries,
  atomicWrite,
  clearInboxEntries,
  inboxEntryId,
  loadConfig,
  pathExists,
  readFile,
  readInboxEntries,
  redact,
  remove,
  statePath
} from "./chunk-FK65OKCK.mjs";

// src/hooks/inbox-tx.ts
import { randomBytes } from "crypto";
var TxError = class extends Error {
};
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
function asRecord(value, what) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TxError(`${what} must be a JSON object`);
  }
  return value;
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
function doAppend(input) {
  const inbox = requireString(input, "inbox");
  const key = requireString(input, "key");
  const raw = input["entries"];
  if (!Array.isArray(raw)) throw new TxError('"entries" must be an array');
  const secrets = loadConfig().secrets;
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const entries = raw.map((item, i) => {
    const entry = asRecord(item, `entries[${String(i)}]`);
    const text = redact(requireString(entry, "text"), secrets);
    const src = requireString(entry, "src");
    return { id: inboxEntryId(src + text), text, src, ts };
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
  const stored = asRecord(JSON.parse(readFile(path)), "snapshot file");
  const ids = stored["ids"];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new TxError("corrupt snapshot file");
  }
  const result = clearInboxEntries(inbox, key, ids);
  remove(path);
  return result;
}
async function main() {
  const subcommand = process.argv[2];
  const stdin = await readStdin();
  let input;
  try {
    input = asRecord(JSON.parse(stdin), "stdin");
  } catch (err) {
    throw new TxError(err instanceof TxError ? err.message : "stdin is not valid JSON");
  }
  switch (subcommand) {
    case "append":
      return void process.stdout.write(JSON.stringify(doAppend(input)) + "\n");
    case "snapshot":
      return void process.stdout.write(JSON.stringify(doSnapshot(input)) + "\n");
    case "clear":
      return void process.stdout.write(JSON.stringify(doClear(input)) + "\n");
    default:
      throw new TxError(
        `unknown subcommand "${subcommand ?? ""}" (expected append|snapshot|clear)`
      );
  }
}
try {
  await main();
} catch (err) {
  process.stderr.write(`inbox-tx: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
}
