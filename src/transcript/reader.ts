/**
 * Tolerant JSONL reader for heterogeneous Claude Code transcripts.
 *
 * Real transcripts contain a mix of record types: message records, mode records,
 * file-history-snapshot records, and others. Malformed lines are skipped and counted,
 * never fatal. Returns the parsed records and a skipped-line count; the caller decides
 * whether to log a warning based on the skip ratio.
 */

import { readFile } from '../core/fs.js';

/** A single record from the transcript JSONL file. */
export type TranscriptRecord = Record<string, unknown> & { uuid?: string; type?: string };

/** Result from reading a transcript. */
export interface ReadTranscriptResult {
  /** Parsed records (complete, valid JSON lines). */
  records: TranscriptRecord[];
  /** Number of lines skipped (malformed JSON or truncation at EOF). */
  skipped: number;
}

/**
 * Read and parse a transcript JSONL file.
 *
 * Parses each line as JSON. Malformed lines (JSON parse errors) are skipped silently
 * and counted. The caller is responsible for checking the skip ratio and logging
 * E_DISTILL_LOSSY if skipped > 10% of total lines.
 *
 * @param path - Path to the transcript.jsonl file
 * @returns Records and skipped count
 */
export function readTranscript(path: string): ReadTranscriptResult {
  const contents = readFile(path);
  const lines = contents.split('\n');
  const records: TranscriptRecord[] = [];
  let skipped = 0;

  for (const line of lines) {
    // Empty lines are normal (final newline, blank lines).
    if (!line.trim()) {
      continue;
    }

    // Try to parse as JSON.
    try {
      const record: TranscriptRecord = JSON.parse(line);
      records.push(record);
    } catch {
      // Malformed JSON: skip and count.
      skipped++;
    }
  }

  return { records, skipped };
}
