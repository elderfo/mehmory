/**
 * Token estimation: chars/4 heuristic with documented tolerance.
 *
 * Exported constants for injection budget allocation and estimation tolerance.
 */

// Named constants for fail-open bounds (A8)
// ponytail: If throughput/precision matters, upgrade to token counter dependency
// (e.g., js-tiktoken for Claude). For now, chars/4 is simple and ±20% tolerance
// is documented and acceptable.

export const TOKENS_PER_CHAR = 0.25; // chars/4 heuristic
export const TOKEN_ESTIMATION_TOLERANCE_PCT = 20; // documented ±20% tolerance

// Injection budget allocation (resolves Spec gap 1)
export const INJECTION_IDENTITY_TOKENS = 200;
export const INJECTION_PROJECT_TOKENS = 200;
export const INJECTION_INDEX_TOKENS = 400;
export const INJECTION_BUDGET_TOKENS = 800; // sum of above

/**
 * Estimate the number of tokens in a text string using chars/4 heuristic.
 *
 * TOLERANCE: This is an estimate. The ±20% tolerance (documented here, not hidden)
 * means a nominal 800-token cap may actually be ~640–960 tokens depending on
 * character composition and model tokenization.
 *
 * @param text — The text to estimate
 * @returns Estimated token count (rounded up)
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  try {
    // chars / 4, rounded up
    return Math.ceil(text.length * TOKENS_PER_CHAR);
  } catch {
    // On any error, return 0 (safe fallback)
    return 0;
  }
}
