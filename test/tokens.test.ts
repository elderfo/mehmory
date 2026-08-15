import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  TOKENS_PER_CHAR,
  TOKEN_ESTIMATION_TOLERANCE_PCT,
  INJECTION_BUDGET_TOKENS,
  INJECTION_IDENTITY_TOKENS,
  INJECTION_PROJECT_TOKENS,
  INJECTION_INDEX_TOKENS,
  INJECTION_AGENT_TOKENS,
} from '../src/core/tokens.js';

describe('estimateTokens', () => {
  it('estimates tokens using chars/4 heuristic', () => {
    const text = 'hello world'; // 11 chars → 2.75 tokens, ceil to 3
    const tokens = estimateTokens(text);
    expect(tokens).toBe(3);
  });

  it('rounds up partial tokens', () => {
    const text = 'abc'; // 3 chars → 0.75 tokens, ceil to 1
    const tokens = estimateTokens(text);
    expect(tokens).toBe(1);
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles very long text', () => {
    const longText = 'a'.repeat(10_000);
    const tokens = estimateTokens(longText);
    expect(tokens).toBe(2500); // 10000 / 4
  });

  it('estimates within documented ±20% tolerance', () => {
    // Test that estimates stay within the documented ±20% tolerance band.
    // Reference: using the same chars/4 heuristic as the implementation.
    // This is inherently circular (same formula), but verifies consistency.

    const testCases = [
      { text: 'hello world', chars: 11, expected: 3 }, // ceil(11 * 0.25) = 3
      { text: 'a'.repeat(100), chars: 100, expected: 25 }, // ceil(100 * 0.25) = 25
      { text: 'x'.repeat(1000), chars: 1000, expected: 250 }, // ceil(1000 * 0.25) = 250
      { text: 'test', chars: 4, expected: 1 }, // ceil(4 * 0.25) = 1
    ];

    for (const testCase of testCases) {
      const estimate = estimateTokens(testCase.text);
      const tolerance = TOKEN_ESTIMATION_TOLERANCE_PCT / 100;
      const lowerBound = testCase.expected * (1 - tolerance);
      const upperBound = testCase.expected * (1 + tolerance);

      // Estimate must equal the expected value from the formula
      expect(estimate).toBe(testCase.expected);

      // And must be within the tolerance band (this is always true if estimate === expected)
      expect(estimate).toBeGreaterThanOrEqual(lowerBound);
      expect(estimate).toBeLessThanOrEqual(upperBound);
    }
  });

  it('returns 0 for non-string input', () => {
    // Deliberately smuggle null/undefined past the `text: string` type to
    // exercise the runtime guard — `unknown` avoids `any` while doing it.
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it('never throws on any input', () => {
    expect(() => estimateTokens('')).not.toThrow();
    expect(() => estimateTokens('a'.repeat(100_000))).not.toThrow();
  });
});

describe('injection budget constants', () => {
  it('exports correct allocation', () => {
    expect(INJECTION_IDENTITY_TOKENS).toBe(200);
    expect(INJECTION_PROJECT_TOKENS).toBe(200);
    expect(INJECTION_INDEX_TOKENS).toBe(400);
  });

  it('budgets sum to 800', () => {
    expect(INJECTION_BUDGET_TOKENS).toBe(
      INJECTION_IDENTITY_TOKENS + INJECTION_PROJECT_TOKENS + INJECTION_INDEX_TOKENS
    );
    expect(INJECTION_BUDGET_TOKENS).toBe(800);
  });

  it('sizes the agent slot at the identity slot, outside the 800 sum', () => {
    expect(INJECTION_AGENT_TOKENS).toBe(INJECTION_IDENTITY_TOKENS);
    // The named total is budget_tokens + this slot, so it must not be folded into the
    // three-way sum a lowered or raised budget_tokens divides.
    expect(INJECTION_BUDGET_TOKENS).toBe(
      INJECTION_IDENTITY_TOKENS + INJECTION_PROJECT_TOKENS + INJECTION_INDEX_TOKENS
    );
  });

  it('uses TOKENS_PER_CHAR constant', () => {
    expect(TOKENS_PER_CHAR).toBe(0.25);
  });
});
