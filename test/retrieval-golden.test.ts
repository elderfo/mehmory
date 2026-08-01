/**
 * Recall@K harness over `test/fixtures/golden-queries.json`.
 *
 * The point is not that these assertions pass — it is that the numbers exist. A
 * retrieval change (weighting, tokenizer, stopwords, a future semantic layer) is judged
 * by running this before and after; without a fixed query set, "it feels better" is the
 * only available evidence, and that is how retrieval regressions ship.
 *
 * Floors, not exact numbers: the assertion catches a regression without failing on an
 * improvement. Raise a floor when a change clears it — that is the ratchet.
 *
 * The paraphrase split is deliberately reported on its own. Those queries share no
 * vocabulary with their target page, so keyword matching structurally cannot answer
 * them: their score is the size of the gap a semantic layer would have to close, and
 * the honest input to deciding whether that layer is worth building.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempDir } from './helpers.js';
import { matchPages } from '../src/core/match.js';

interface GoldenQuery {
  readonly id: string;
  readonly query: string;
  readonly expect: string;
  readonly paraphrase?: boolean;
  readonly notes?: string;
}

interface GoldenSet {
  readonly pages: Readonly<Record<string, string>>;
  readonly queries: readonly GoldenQuery[];
}

const golden = JSON.parse(
  readFileSync(resolve('test/fixtures/golden-queries.json'), 'utf-8')
) as GoldenSet;

/** Materialize the fixture wiki once; every query runs against the same corpus. */
function seedCorpus(): string {
  const pagesDir = join(createTempDir('mehmory-golden'), 'pages');
  mkdirSync(pagesDir, { recursive: true });
  for (const [name, body] of Object.entries(golden.pages)) {
    writeFileSync(join(pagesDir, name), body);
  }
  return pagesDir;
}

const PAGES_DIR = seedCorpus();

/** Rank of the expected page in the results, or -1 when it is absent. */
function rankOf(query: GoldenQuery, max: number): number {
  const hits = matchPages(query.query, PAGES_DIR, max);
  return hits.findIndex(hit => hit.path.endsWith(query.expect));
}

function recallAt(k: number, queries: readonly GoldenQuery[]): number {
  const found = queries.filter(q => {
    const rank = rankOf(q, k);
    return rank >= 0 && rank < k;
  }).length;
  return queries.length === 0 ? 0 : found / queries.length;
}

const keyword = golden.queries.filter(q => q.paraphrase !== true);
const paraphrase = golden.queries.filter(q => q.paraphrase === true);

describe('retrieval golden set', () => {
  it('has both a keyword and a paraphrase split to measure', () => {
    // A set of only easy queries reports a great number and tells you nothing.
    expect(keyword.length).toBeGreaterThanOrEqual(10);
    expect(paraphrase.length).toBeGreaterThanOrEqual(3);
  });

  it('every query names a page that exists in the fixture corpus', () => {
    for (const q of golden.queries) {
      expect(Object.keys(golden.pages), q.id).toContain(q.expect);
    }
  });

  it('Recall@1 on keyword queries holds at or above the recorded floor', () => {
    expect(recallAt(1, keyword)).toBeGreaterThanOrEqual(KEYWORD_RECALL_AT_1);
  });

  it('Recall@3 on keyword queries holds at or above the recorded floor', () => {
    expect(recallAt(3, keyword)).toBeGreaterThanOrEqual(KEYWORD_RECALL_AT_3);
  });

  it('records what keyword matching cannot do, rather than hiding it', () => {
    // Asserted as a ceiling, not a floor: this number going UP means something real
    // changed in retrieval and the paraphrase gap should be re-measured, not that a
    // test needs silencing.
    const measured = recallAt(3, paraphrase);
    expect(measured).toBeLessThanOrEqual(PARAPHRASE_RECALL_AT_3_CEILING);
  });
});

// ─── Recorded measurements ───
//
// Measured, not guessed, against the fixture corpus with the grep matcher as of the
// commit that added this file:
//
//   keyword    Recall@1 = 12/12 = 1.00     Recall@3 = 12/12 = 1.00
//   paraphrase Recall@1 =  0/4  = 0.00     Recall@3 =  1/4  = 0.25
//
// Update these deliberately, in a commit that says what changed in retrieval — never to
// make a red test go green.

/**
 * Keyword queries where the right page ranks first. Floored at the measured value: the
 * matcher is deterministic, so there is no noise to leave margin for, and any drop is a
 * real regression.
 *
 * That this is a perfect score is itself a finding, not a victory lap — on queries that
 * share vocabulary with their target page, grep is genuinely hard to beat, and the
 * keyword split therefore has little headroom to discriminate future changes. The
 * paraphrase split below is where this set does its real work.
 */
const KEYWORD_RECALL_AT_1 = 1.0;

/** Keyword queries where the right page appears in the top 3. */
const KEYWORD_RECALL_AT_3 = 1.0;

/**
 * Paraphrase queries the keyword matcher answers by luck (incidental shared vocabulary):
 * 1 of 4, and 0 of 4 at K=1. The gap between that and 1.0 is the concrete size of what a
 * semantic layer would buy — three of four questions a user would plausibly ask get no
 * useful answer today.
 *
 * Asserted as a ceiling rather than a floor so it acts as a tripwire: if this rises,
 * something real changed in retrieval and the gap needs re-measuring (and this number
 * re-recording), which is exactly the moment worth noticing.
 */
const PARAPHRASE_RECALL_AT_3_CEILING = 0.25;
