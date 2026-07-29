/**
 * Distill transcript records into inbox entries.
 *
 * Extracts user messages, decision markers, correction patterns, and error resolutions
 * from a transcript using the enumerated pattern list. Each entry carries a stable ID
 * based on sha256(sessionId + record.uuid), enabling idempotent cursor replay.
 */

import { createHash } from 'node:crypto';
import { DISTILL_PATTERNS, type DistilledEntry } from './patterns.js';
import type { TranscriptRecord } from '../transcript/reader.js';

/**
 * Distill a list of transcript records into inbox entries.
 *
 * Applies each pattern in order to each record. The first matching pattern produces
 * the entry; a record can only match one pattern. Records without a uuid are skipped
 * (cannot produce stable IDs).
 *
 * @param records - Parsed transcript records
 * @param sessionId - Session identifier for stable ID generation
 * @returns Distilled entries
 */
export function distill(
  records: TranscriptRecord[],
  sessionId: string
): DistilledEntry[] {
  const entries: DistilledEntry[] = [];

  for (const [i, record] of records.entries()) {
    // Skip records without UUIDs (cannot produce stable IDs).
    if (!record.uuid || typeof record.uuid !== 'string') {
      continue;
    }

    // Match against patterns in order (first match wins).
    for (const pattern of DISTILL_PATTERNS) {
      if (pattern.matches(record)) {
        const content = pattern.extract(record);
        if (content) {
          // Generate stable ID: sha256(sessionId + record.uuid).
          const hash = createHash('sha256')
            .update(sessionId)
            .update(record.uuid)
            .digest('hex');

          entries.push({
            id: hash,
            pattern: pattern.name,
            content,
            source: {
              sessionId,
              recordUuid: record.uuid,
              recordType: record.type as string | undefined,
              lineNumber: i,
            },
          });
        }
        break; // Only one pattern per record.
      }
    }
  }

  return entries;
}
