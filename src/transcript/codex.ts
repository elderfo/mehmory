/**
 * Codex rollout reader — normalizes Codex's on-disk shape into `TranscriptRecord`.
 *
 * Codex writes an event envelope with a nested payload: `{timestamp, type, payload}`,
 * where `payload.type` names the event. Only two payload types carry conversation
 * material — `user_message` and `agent_message` — and neither carries a record uuid,
 * which the distiller needs for stable ids.
 *
 * This module is the normalization boundary (A7): everything above it, distillation
 * included, sees exactly one record type and never learns which harness produced it.
 *
 * `response_item|message` records are deliberately ignored. They are the API-level
 * history and restate the same turns as the `event_msg` stream, so reading both would
 * file every user message twice.
 */

import { createHash } from 'node:crypto';
import { readTranscript, type ReadTranscriptResult, type TranscriptRecord } from './reader.js';

/**
 * Read a Codex rollout into normalized transcript records.
 *
 * Tolerance, incremental resume and the returned `endOffset` are inherited from
 * `readTranscript` — the envelope is still JSONL, so only the mapping differs. Lines
 * that parse but are not conversation events (tool calls, token counts, reasoning) are
 * dropped without counting as skipped: they are well-formed records this reader has no
 * use for, and inflating `skipped` with them would trip E_DISTILL_LOSSY on every pass.
 *
 * @param path - Path to the rollout .jsonl file
 * @param startOffset - Byte offset to resume from (default 0 = whole file)
 */
export function readCodexRollout(path: string, startOffset = 0): ReadTranscriptResult {
  const { records: envelopes, skipped, endOffset } = readTranscript(path, startOffset);

  const records: TranscriptRecord[] = [];
  // The rollout's own uuid, which is what a Codex hook payload reports as `session_id`.
  // `session_meta.session_id` is the conversation id and is shared across resume, fork
  // and subagent rollouts, so keying on it would merge distinct sessions.
  let sessionId: string | undefined;

  for (const envelope of envelopes) {
    const payload = asRecord(envelope.payload);
    if (!payload) continue;

    if (envelope.type === 'session_meta') {
      const id = payload['id'];
      if (typeof id === 'string' && id) sessionId = id;
      continue;
    }

    if (envelope.type !== 'event_msg') continue;

    const role =
      payload['type'] === 'user_message'
        ? 'user'
        : payload['type'] === 'agent_message'
          ? 'assistant'
          : undefined;
    if (!role) continue;

    const text = payload['message'];
    if (typeof text !== 'string' || !text) continue;

    const timestamp = typeof envelope.timestamp === 'string' ? envelope.timestamp : '';

    records.push({
      type: 'message',
      role,
      text,
      timestamp,
      uuid: syntheticUuid(timestamp, role, text),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  return { records, skipped, endOffset };
}

/**
 * Mint the record uuid Codex does not supply.
 *
 * Derived from content rather than position so it survives incremental reads: a resumed
 * pass starts at a byte offset and has no idea which line number it is on, and an id
 * that shifted with the read window would re-file the whole session on every resume.
 *
 * ponytail: two byte-identical messages of the same role in the same millisecond collapse
 * to one entry (5 occurrences across 163 local rollouts, all literal duplicates). Upgrade
 * path: thread the line's absolute byte offset out of `readTranscript` and hash that.
 */
function syntheticUuid(timestamp: string, role: string, text: string): string {
  return createHash('sha256').update(timestamp).update(role).update(text).digest('hex').slice(0, 32);
}

/** Narrow an unknown envelope field to an object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
