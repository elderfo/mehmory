import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  TOKENS_PER_CHAR,
  TOKEN_ESTIMATION_TOLERANCE_PCT,
  INJECTION_BUDGET_TOKENS,
  INJECTION_IDENTITY_TOKENS,
  INJECTION_PROJECT_TOKENS,
  INJECTION_INDEX_TOKENS,
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

  it('documents ±20% tolerance', () => {
    // The tolerance is documented in the function; here we just verify it's exported
    expect(TOKEN_ESTIMATION_TOLERANCE_PCT).toBe(20);
  });

  it('returns 0 for non-string input', () => {
    expect(estimateTokens(null as any)).toBe(0);
    expect(estimateTokens(undefined as any)).toBe(0);
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

  it('uses TOKENS_PER_CHAR constant', () => {
    expect(TOKENS_PER_CHAR).toBe(0.25);
  });
});
