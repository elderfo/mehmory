import {
  readFileFromNoFollow
} from "./chunk-B6KFCQBF.mjs";

// src/transcript/pi.ts
import { createHash } from "crypto";

// src/transcript/reader.ts
function readTranscript(path, startOffset = 0) {
  const begin = startOffset > 0 ? startOffset : 0;
  const contents = readFileFromNoFollow(path, begin);
  const lastNewline = contents.lastIndexOf("\n");
  const consumable = lastNewline >= 0 ? contents.slice(0, lastNewline + 1) : "";
  const endOffset = begin + Buffer.byteLength(consumable, "utf-8");
  const lines = consumable.split("\n");
  const records = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) {
        skipped++;
        continue;
      }
      records.push(parsed);
    } catch {
      skipped++;
    }
  }
  return { records, skipped, endOffset };
}

// src/transcript/pi.ts
var SKILL_ENVELOPE = /^<skill name="[^"]+" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
function stripPiSkillEnvelope(text) {
  const match = SKILL_ENVELOPE.exec(text);
  if (!match) return text;
  return match[1]?.trim() ?? "";
}
function readPiSession(path, startOffset = 0) {
  const { records: entries, skipped, endOffset } = readTranscript(path, startOffset);
  const records = [];
  let sessionId;
  for (const entry of entries) {
    if (entry.type === "session") {
      const id2 = entry["id"];
      if (typeof id2 === "string" && id2) sessionId = id2;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = asRecord(entry["message"]);
    const role = message?.["role"];
    if (role !== "user" && role !== "assistant") continue;
    const raw = contentText(message?.["content"]);
    const text = role === "user" ? stripPiSkillEnvelope(raw) : raw;
    if (!text) continue;
    const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : "";
    const id = entry["id"];
    records.push({
      type: "message",
      role,
      text,
      timestamp,
      uuid: typeof id === "string" && id ? id : syntheticUuid(timestamp, role, text),
      ...sessionId === void 0 ? {} : { sessionId }
    });
  }
  return { records, skipped, endOffset };
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.["type"] === "text" && typeof record["text"] === "string" && record["text"]) {
      parts.push(record["text"]);
    }
  }
  return parts.join("\n");
}
function syntheticUuid(timestamp, role, text) {
  return createHash("sha256").update(timestamp).update(role).update(text).digest("hex").slice(0, 32);
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

export {
  readTranscript,
  stripPiSkillEnvelope,
  readPiSession
};
