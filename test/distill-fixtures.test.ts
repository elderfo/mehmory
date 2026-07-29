import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { distill } from '../src/distill/distill.js';
import type { TranscriptRecord } from '../src/transcript/reader.js';

/**
 * Fixture-based contract test: each .jsonl input paired with .distilled.json output
 * asserts exact equality. Fixtures are normative per ADR A7.
 */
describe('distill fixtures (normative)', () => {
  const fixtureDir = join(__dirname, 'fixtures', 'transcripts');

  // Find all .jsonl files and pair with .distilled.json
  const jsonlFiles = readdirSync(fixtureDir).filter((f) => f.endsWith('.jsonl'));

  for (const jsonlFile of jsonlFiles) {
    const baseName = jsonlFile.replace('.jsonl', '');
    const jsonlPath = join(fixtureDir, jsonlFile);
    const expectedPath = join(fixtureDir, `${baseName}.distilled.json`);

    it(`${baseName}: input matches expected output`, () => {
      // Read and parse input records (skip malformed lines like readTranscript does)
      const content = readFileSync(jsonlPath, 'utf-8');
      const records: TranscriptRecord[] = content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as TranscriptRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is TranscriptRecord => r !== null);

      // Run distill
      const result = distill(records, 'test-session');

      // Read expected output
      const expected = JSON.parse(readFileSync(expectedPath, 'utf-8')) as typeof result;

      // Assert exact equality
      expect(result).toEqual(expected);
    });
  }
});
