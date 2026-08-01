import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { distill } from '../src/distill/distill.js';
import { readSession, type Host } from '../src/transcript/host.js';

/**
 * Fixture-based contract test: each .jsonl input paired with .distilled.json output
 * asserts exact equality. Fixtures are normative per ADR A7.
 *
 * Input goes through the real reader, not a local JSON.parse loop. Parsing lines
 * straight into the normalized type only ever worked because Claude Code's on-disk
 * shape IS the normalized shape; a Codex rollout's is not, so the fixture would have
 * asserted against a record stream no production path ever produces.
 *
 * A `codex-` filename prefix names the host — the only harness signal in the test, and
 * it stops at `readSession`. Nothing below it knows which harness wrote the fixture.
 */
describe('distill fixtures (normative)', () => {
  const fixtureDir = join(__dirname, 'fixtures', 'transcripts');

  const jsonlFiles = readdirSync(fixtureDir).filter(f => f.endsWith('.jsonl'));

  for (const jsonlFile of jsonlFiles) {
    const baseName = jsonlFile.replace('.jsonl', '');
    const host: Host = baseName.startsWith('codex-') ? 'codex' : 'claude-code';
    const jsonlPath = join(fixtureDir, jsonlFile);
    const expectedPath = join(fixtureDir, `${baseName}.distilled.json`);

    it(`${baseName} (${host}): input matches expected output`, () => {
      const { records } = readSession(jsonlPath, host);
      const result = distill(records, 'test-session');
      const expected = JSON.parse(readFileSync(expectedPath, 'utf-8')) as typeof result;
      expect(result).toEqual(expected);
    });
  }
});
