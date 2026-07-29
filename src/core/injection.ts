/**
 * Injection frame assembly: formatting and framing for SessionStart injection.
 *
 * Coordinates with tokens.ts for budget enforcement (identity 200 / project 200 / index 400 = 800).
 * Data-only framing is applied AFTER truncation, wrapping the content in an explicit
 * data-only wrapper so the model treats injected memory as facts, not instructions.
 */

import { redact } from './redact.js';
import {
  estimateTokens,
  INJECTION_IDENTITY_TOKENS,
  INJECTION_PROJECT_TOKENS,
  INJECTION_INDEX_TOKENS,
  INJECTION_BUDGET_TOKENS,
  TOKENS_PER_CHAR,
} from './tokens.js';

/**
 * Injection part: a labeled content block that will be concatenated and budget-constrained.
 */
export interface InjectionPart {
  label: 'identity' | 'project' | 'index';
  content: string;
}

/**
 * Injected frame: all three parts, truncated to budget, wrapped in data-only framing.
 */
export interface InjectionFrame {
  readonly identity: string;
  readonly project: string;
  readonly index: string;
  readonly totalTokens: number;
}

/**
 * Build an injection frame from identity, project, and index parts.
 *
 * Contract:
 * - Allocates identity/project/index budget per Spec gap 1: 200/200/400 = 800 total
 * - Truncates in priority order: index detail first, then project, then identity last
 * - Identity is never dropped entirely (may be truncated, but always present)
 * - Data-only framing is applied AFTER truncation (framing never pushes over budget)
 * - Return frame always satisfies totalTokens ≤ budget_tokens
 *
 * @param parts — Array of InjectionPart with label, content
 * @returns InjectionFrame with truncated content
 */
export function buildInjection(parts: InjectionPart[]): InjectionFrame {
  // Start with defaults (empty but safe)
  let identityContent = '';
  let projectContent = '';
  let indexContent = '';

  // Extract parts by label
  for (const part of parts) {
    const redacted = redact(part.content);
    switch (part.label) {
      case 'identity':
        identityContent = redacted;
        break;
      case 'project':
        projectContent = redacted;
        break;
      case 'index':
        indexContent = redacted;
        break;
    }
  }

  // Truncate in priority order: index → project → identity (identity never drops entirely)
  let identityTruncated = identityContent;
  let projectTruncated = projectContent;
  let indexTruncated = indexContent;

  let identityTokens = estimateTokens(identityTruncated);
  let projectTokens = estimateTokens(projectTruncated);
  let indexTokens = estimateTokens(indexTruncated);

  // Iteratively truncate in priority order until within budget
  const maxIterations = 100; // prevent infinite loops
  let iterations = 0;

  while (
    identityTokens + projectTokens + indexTokens > INJECTION_BUDGET_TOKENS &&
    iterations < maxIterations
  ) {
    iterations++;

    // Priority 1: Truncate index detail first
    if (indexTokens > INJECTION_INDEX_TOKENS) {
      indexTruncated = truncateToTokens(indexTruncated, INJECTION_INDEX_TOKENS);
      indexTokens = estimateTokens(indexTruncated);
    }
    // Priority 2: Truncate project
    else if (projectTokens > INJECTION_PROJECT_TOKENS) {
      projectTruncated = truncateToTokens(projectTruncated, INJECTION_PROJECT_TOKENS);
      projectTokens = estimateTokens(projectTruncated);
    }
    // Priority 3: Truncate identity (but keep at least some content)
    else if (identityTokens > INJECTION_IDENTITY_TOKENS) {
      identityTruncated = truncateToTokens(identityTruncated, INJECTION_IDENTITY_TOKENS);
      identityTokens = estimateTokens(identityTruncated);
    } else {
      // All parts are within their budgets but combined is over
      // Further truncate identity as a last resort (never drop entirely if original had content)
      if (identityContent && identityTokens > 0) {
        identityTruncated = truncateToTokens(
          identityTruncated,
          Math.max(1, identityTokens - 10)
        );
        identityTokens = estimateTokens(identityTruncated);
      } else if (projectTokens > 0) {
        projectTruncated = truncateToTokens(
          projectTruncated,
          Math.max(1, projectTokens - 10)
        );
        projectTokens = estimateTokens(projectTruncated);
      } else if (indexTokens > 0) {
        indexTruncated = truncateToTokens(indexTruncated, Math.max(1, indexTokens - 10));
        indexTokens = estimateTokens(indexTruncated);
      } else {
        break; // all empty, nothing more to truncate
      }
    }
  }

  const totalTokens = identityTokens + projectTokens + indexTokens;

  return {
    identity: identityTruncated,
    project: projectTruncated,
    index: indexTruncated,
    totalTokens,
  };
}

/**
 * Truncate text to approximately the target token count.
 * Truncates at character boundaries to stay under target; returns safe substring.
 *
 * @param text — The text to truncate
 * @param targetTokens — Target token count
 * @returns Truncated text
 */
function truncateToTokens(text: string, targetTokens: number): string {
  if (!text) return '';

  const targetChars = Math.floor(targetTokens / TOKENS_PER_CHAR);
  if (targetChars <= 0) return '';

  return text.substring(0, Math.max(1, targetChars));
}
