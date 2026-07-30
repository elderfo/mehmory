/**
 * Tolerant JSONL reader for heterogeneous Claude Code transcripts.
 *
 * Real transcripts contain a mix of record types: message records, mode records,
 * file-history-snapshot records, and others. Malformed lines are skipped and counted,
 * never fatal. Returns the parsed records and a skipped-line count; the caller decides
 * whether to log a warning based on the skip ratio.
 */

import { readFileFrom } from '../core/fs.js';

/** A single record from the transcript JSONL file. */
export type TranscriptRecord = Record<string, unknown> & {
  uuid?: string;
  type?: string;
  /** Session that produced the record; survives resume, unlike the invoking session id. */
  sessionId?: string;
};

/** Result from reading a transcript. */
export interface ReadTranscriptResult {
  /** Parsed records (complete, valid JSON lines). */
  records: TranscriptRecord[];
  /** Number of lines skipped (malformed JSON or truncation at EOF). */
  skipped: number;
  /**
   * Byte offset just past the last COMPLETE line consumed. Feed this to
   * advanceCursor so the next pass resumes here instead of re-reading. A trailing
   * partial line (a record still being written) is excluded, so no half record is
   * ever consumed and the offset never advances past one.
   */
  endOffset: number;
}

/**
 * Read and parse a transcript JSONL file, optionally resuming from a byte offset.
 *
 * Parses each line as JSON. Malformed lines (JSON parse errors) are skipped silently
 * and counted. The caller is responsible for checking the skip ratio and logging
 * E_DISTILL_LOSSY if skipped > 10% of total lines.
 *
 * `startOffset` is what makes the cursor worth storing. Claude transcripts reach
 * tens of MB; without it every invocation re-reads and re-parses the whole file,
 * and the cursor's offset field has no consumer at all.
 *
 * @param path - Path to the transcript.jsonl file
 * @param startOffset - Byte offset to resume from (default 0 = whole file)
 * @returns Records, skipped count, and the offset to persist
 */
export function readTranscript(path: string, startOffset = 0): ReadTranscriptResult {
  // Read only from the offset forward. Offsets are byte-based (that is what
  // stat().size reports and what the cursor stores), and readFileFrom seeks rather
  // than reading-then-slicing, so resuming near the end of a 50 MB transcript costs
  // the size of the tail rather than the size of the file.
  const begin = startOffset > 0 ? startOffset : 0;
  const contents = readFileFrom(path, begin);

  // Only whole lines are consumable. If the tail has no trailing newline it is a
  // partial write; leave it for the next pass rather than parsing half a record.
  const lastNewline = contents.lastIndexOf('\n');
  const consumable = lastNewline >= 0 ? contents.slice(0, lastNewline + 1) : '';
  const endOffset = begin + Buffer.byteLength(consumable, 'utf-8');

  const lines = consumable.split('\n');
  const records: TranscriptRecord[] = [];
  let skipped = 0;

  for (const line of lines) {
    // Empty lines are normal (final newline, blank lines).
    if (!line.trim()) {
      continue;
    }

    // Try to parse as JSON.
    try {
      const parsed: unknown = JSON.parse(line);
      // A line can be valid JSON without being a record (e.g. a bare number from a
      // torn write); those count as skipped rather than entering the record stream.
      if (typeof parsed !== 'object' || parsed === null) {
        skipped++;
        continue;
      }
      records.push(parsed as TranscriptRecord);
    } catch {
      // Malformed JSON: skip and count.
      skipped++;
    }
  }

  return { records, skipped, endOffset };
}
