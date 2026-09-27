/**
 * Pi session reader — normalizes Pi's on-disk session tree into `TranscriptRecord`.
 *
 * A Pi session file opens with a `session` header whose `id` is what the extension
 * reports as `session_id`, then one entry per line. Only `message` entries whose
 * `message.role` is `user` or `assistant` carry conversation material; everything else
 * (model changes, compactions, labels, mehmory's own `custom_message` injections) is
 * well-formed session bookkeeping this reader has no use for.
 *
 * This module is the normalization boundary (A7): everything above it, distillation
 * included, sees exactly one record type and never learns which harness produced it.
 *
 * ponytail: the file is a tree (`parentId`), and every branch is read, abandoned ones
 * included. Upgrade path: walk `parentId` back from the leaf and keep only that path.
 */

import { createHash } from 'node:crypto';
import { readTranscript, type ReadTranscriptResult, type TranscriptRecord } from './reader.js';

/**
 * Pi's own skill-invocation grammar (`parseSkillBlock` in pi-coding-agent 0.87.1): the
 * expanded SKILL.md body in an envelope, then the user's arguments after a blank line.
 */
const SKILL_ENVELOPE = /^<skill name="[^"]+" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Strip the `/skill:<name>` expansion from a user prompt, keeping only what the user
 * typed after it.
 *
 * Pi stores a skill invocation as one user text: the whole SKILL.md body wrapped in a
 * `<skill>` envelope, followed by the arguments. The body is mehmory's (or another
 * package's) instructions, not anything the user said, so distilling it would file skill
 * prose as a user decision. Text without the envelope comes back unchanged; an envelope
 * with no arguments comes back as ''.
 */
export function stripPiSkillEnvelope(text: string): string {
  const match = SKILL_ENVELOPE.exec(text);
  if (!match) return text;
  return match[1]?.trim() ?? '';
}

/**
 * Read a Pi session file into normalized transcript records.
 *
 * Tolerance, incremental resume and the returned `endOffset` are inherited from
 * `readTranscript`. Lines that parse but are not conversation messages are dropped
 * without counting as skipped: inflating `skipped` with them would trip E_DISTILL_LOSSY
 * on every pass over a healthy file.
 *
 * @param path - Path to the session .jsonl file
 * @param startOffset - Byte offset to resume from (default 0 = whole file)
 */
export function readPiSession(path: string, startOffset = 0): ReadTranscriptResult {
  const { records: entries, skipped, endOffset } = readTranscript(path, startOffset);

  const records: TranscriptRecord[] = [];
  let sessionId: string | undefined;

  for (const entry of entries) {
    if (entry.type === 'session') {
      const id = entry['id'];
      if (typeof id === 'string' && id) sessionId = id;
      continue;
    }

    if (entry.type !== 'message') continue;
    const message = asRecord(entry['message']);
    const role = message?.['role'];
    if (role !== 'user' && role !== 'assistant') continue;

    const raw = contentText(message?.['content']);
    const text = role === 'user' ? stripPiSkillEnvelope(raw) : raw;
    if (!text) continue;

    const timestamp = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : '';
    const id = entry['id'];

    records.push({
      type: 'message',
      role,
      text,
      timestamp,
      uuid: typeof id === 'string' && id ? id : syntheticUuid(timestamp, role, text),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  return { records, skipped, endOffset };
}

/** A message's text: string content as is, or its `text` blocks joined by newlines. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.['type'] === 'text' && typeof record['text'] === 'string' && record['text']) {
      parts.push(record['text']);
    }
  }
  return parts.join('\n');
}

/**
 * Mint a record uuid for an entry that lacks Pi's `id`. Content-derived, as in the Codex
 * reader, so a resumed pass mints the same id the first pass did.
 */
function syntheticUuid(timestamp: string, role: string, text: string): string {
  return createHash('sha256').update(timestamp).update(role).update(text).digest('hex').slice(0, 32);
}

/** Narrow an unknown entry field to an object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
