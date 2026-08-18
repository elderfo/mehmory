/**
 * Injection frame assembly: formatting and framing for SessionStart injection.
 *
 * Coordinates with tokens.ts for budget enforcement (identity 200 / project 200 / index 400 = 800).
 * A named agent adds a fourth share the same nominal size as identity, taken out of the
 * same budget rather than added on top of it — `injection.budget_tokens` stays the cap.
 * Data-only framing is applied AFTER truncation, wrapping the content in an explicit
 * data-only wrapper so the model treats injected memory as facts, not instructions.
 */

import { redact, type RedactOptions } from './redact.js';
import {
  estimateTokens,
  INJECTION_IDENTITY_TOKENS,
  INJECTION_PROJECT_TOKENS,
  INJECTION_BUDGET_TOKENS,
  TOKENS_PER_CHAR,
} from './tokens.js';

/**
 * Injection part: a labeled content block that will be concatenated and budget-constrained.
 */
export interface InjectionPart {
  label: 'identity' | 'project' | 'index' | 'agent';
  content: string;
}

/**
 * Injected frame: every part, truncated to budget, wrapped in data-only framing.
 */
export interface InjectionFrame {
  readonly identity: string;
  readonly project: string;
  readonly index: string;
  /** The agent's own content. Absent — not empty — when the agent is unnamed. */
  readonly agent?: string;
  readonly totalTokens: number;
}

/**
 * Result from truncateToTokens: truncated text and its token count.
 * Returned together to avoid re-counting the same text.
 */
interface TruncationResult {
  text: string;
  tokens: number;
}

/** Config the injection path needs, threaded from a single `loadConfig()` per
 * process (criterion 13) — this function never reads config from disk itself. */
export interface InjectionOptions {
  /** `config.injection.budget_tokens`. Defaults to `INJECTION_BUDGET_TOKENS` (800). */
  readonly budgetTokens?: number;
  /** `config.secrets`, forwarded to `redact()`. */
  readonly secrets?: RedactOptions;
}

/**
 * Build an injection frame from identity, project, index, and (optionally) agent parts.
 *
 * Contract:
 * - Allocates identity/project/index budget in the 200/200/400 ratio of Spec gap 1,
 *   scaled to `budgetTokens` (default 800, so the default split is exactly 200/200/400)
 * - A named agent adds a fourth share nominally equal to identity's, and all four scale
 *   to the same `budgetTokens`. The budget is a cap, not a floor: naming an agent buys
 *   its self a place in the frame by making room, never by raising the total
 * - Passing no agent part leaves the split byte-identical to before agent scopes existed
 * - Truncates in priority order: index detail first, then project, then agent, then
 *   identity last
 * - Identity is never dropped entirely (may be truncated, but always present)
 * - Data-only framing is applied AFTER truncation (framing never pushes over budget)
 * - Return frame always satisfies totalTokens ≤ budget_tokens
 *
 * @param parts — Array of InjectionPart with label, content
 * @param options — Threaded config (budget, secret filter settings)
 * @returns InjectionFrame with truncated content
 */
export function buildInjection(
  parts: InjectionPart[],
  options: InjectionOptions = {}
): InjectionFrame {
  const budget =
    options.budgetTokens !== undefined && options.budgetTokens > 0
      ? options.budgetTokens
      : INJECTION_BUDGET_TOKENS;
  // The agent's nominal share is identity's — an agent's self is worth what the user's
  // self is worth — so a named frame's nominal total is 1000 rather than 800. Every share
  // scales to `budget` against that total, which is what keeps `budget_tokens` a real cap
  // and leaves the unnamed split (scale = budget/800) exactly as it was.
  const isNamed = parts.some(part => part.label === 'agent');
  const nominalTotal = INJECTION_BUDGET_TOKENS + (isNamed ? INJECTION_IDENTITY_TOKENS : 0);
  const scale = budget / nominalTotal;
  const identityBudget = Math.floor(INJECTION_IDENTITY_TOKENS * scale);
  const agentBudget = isNamed ? Math.floor(INJECTION_IDENTITY_TOKENS * scale) : 0;
  const projectBudget = Math.floor(INJECTION_PROJECT_TOKENS * scale);
  // The remainder rather than a scaled INJECTION_INDEX_TOKENS, so the sub-budgets
  // always sum to exactly `budget` after flooring.
  const indexBudget = budget - identityBudget - agentBudget - projectBudget;

  // Start with defaults (empty but safe)
  let identityContent = '';
  let projectContent = '';
  let indexContent = '';
  let agentContent = '';

  // Extract parts by label
  for (const part of parts) {
    const redacted = redact(part.content, options.secrets);
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
      case 'agent':
        agentContent = redacted;
        break;
    }
  }

  // Truncate in priority order: index → project → agent → identity. The agent slot
  // yields before identity, which never drops entirely.
  let identityTruncated = identityContent;
  let projectTruncated = projectContent;
  let indexTruncated = indexContent;
  let agentTruncated = agentContent;

  let identityTokens = estimateTokens(identityTruncated);
  let projectTokens = estimateTokens(projectTruncated);
  let indexTokens = estimateTokens(indexTruncated);
  let agentTokens = estimateTokens(agentTruncated);

  // Iteratively truncate in priority order until within budget
  const maxIterations = 100; // prevent infinite loops
  let iterations = 0;

  while (
    identityTokens + projectTokens + indexTokens + agentTokens > budget &&
    iterations < maxIterations
  ) {
    iterations++;

    // Priority 1: Truncate index detail first
    if (indexTokens > indexBudget) {
      const result = truncateToTokens(indexTruncated, indexBudget);
      indexTruncated = result.text;
      indexTokens = result.tokens;
    }
    // Priority 2: Truncate project
    else if (projectTokens > projectBudget) {
      const result = truncateToTokens(projectTruncated, projectBudget);
      projectTruncated = result.text;
      projectTokens = result.tokens;
    }
    // Priority 3: Truncate the agent slot, which yields before identity does
    else if (agentTokens > agentBudget) {
      const result = truncateToTokens(agentTruncated, agentBudget);
      agentTruncated = result.text;
      agentTokens = result.tokens;
    }
    // Priority 4: Truncate identity (but keep at least some content)
    else if (identityTokens > identityBudget) {
      const result = truncateToTokens(identityTruncated, identityBudget);
      identityTruncated = result.text;
      identityTokens = result.tokens;
    } else {
      // All parts are within their budgets but combined is over
      // Shave the agent slot before identity; identity never drops entirely if it had content
      if (agentContent && agentTokens > 0) {
        const result = truncateToTokens(agentTruncated, Math.max(1, agentTokens - 10));
        agentTruncated = result.text;
        agentTokens = result.tokens;
      } else if (identityContent && identityTokens > 0) {
        const result = truncateToTokens(
          identityTruncated,
          Math.max(1, identityTokens - 10)
        );
        identityTruncated = result.text;
        identityTokens = result.tokens;
      } else if (projectTokens > 0) {
        const result = truncateToTokens(
          projectTruncated,
          Math.max(1, projectTokens - 10)
        );
        projectTruncated = result.text;
        projectTokens = result.tokens;
      } else if (indexTokens > 0) {
        const result = truncateToTokens(indexTruncated, Math.max(1, indexTokens - 10));
        indexTruncated = result.text;
        indexTokens = result.tokens;
      } else {
        break; // all empty, nothing more to truncate
      }
    }
  }

  const totalTokens = identityTokens + projectTokens + indexTokens + agentTokens;

  return {
    identity: identityTruncated,
    project: projectTruncated,
    index: indexTruncated,
    // Omitted rather than empty when no agent part was passed, so `undefined` honestly
    // means unnamed instead of being a sentinel the field never carries.
    ...(isNamed ? { agent: agentTruncated } : {}),
    totalTokens,
  };
}

/**
 * Truncate text to approximately the target token count.
 * Truncates at character boundaries to stay under target; returns safe substring
 * along with its token count to avoid re-counting.
 *
 * @param text — The text to truncate
 * @param targetTokens — Target token count
 * @returns Object with truncated text and its token count
 */
function truncateToTokens(text: string, targetTokens: number): TruncationResult {
  if (!text) {
    return { text: '', tokens: 0 };
  }

  const targetChars = Math.floor(targetTokens / TOKENS_PER_CHAR);
  if (targetChars <= 0) {
    return { text: '', tokens: 0 };
  }

  const truncated = text.substring(0, Math.max(1, targetChars));
  const tokens = estimateTokens(truncated);
  return { text: truncated, tokens };
}
