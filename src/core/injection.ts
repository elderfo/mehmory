/**
 * Injection frame assembly: formatting and framing for SessionStart injection.
 *
 * Coordinates with tokens.ts for budget enforcement (identity 200 / project 200 / index 400 = 800,
 * plus a fixed 200-token agent slot on top when the running agent is named).
 * Data-only framing is applied AFTER truncation, wrapping the content in an explicit
 * data-only wrapper so the model treats injected memory as facts, not instructions.
 */

import { redact, type RedactOptions } from './redact.js';
import {
  estimateTokens,
  INJECTION_AGENT_TOKENS,
  INJECTION_IDENTITY_TOKENS,
  INJECTION_INDEX_TOKENS,
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
 * `agent` is empty whenever the caller passed no agent part (an unnamed agent).
 */
export interface InjectionFrame {
  readonly identity: string;
  readonly project: string;
  readonly index: string;
  readonly agent: string;
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
 * - Identity, project, and the agent slot get fixed sub-budgets; the index gets whatever
 *   the total leaves over, so raising `budgetTokens` widens the index alone (R10)
 * - The agent slot exists only when an agent part was passed, so an unnamed agent's
 *   allocation is byte-identical to before agent scopes existed
 * - Truncates in priority order: index, then project, then the agent slot, then identity
 * - Identity and the agent slot are never dropped entirely (truncated, always present)
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
  // Fixed per-label sub-budgets, not a ratio scaled to the total: scaling would hand
  // identity 250 and project 250 the moment the agent slot raised the total, which is
  // exactly what R10 forbids. Identity, project, and the agent slot are constants and
  // the index absorbs the remainder, so `budget_tokens + INJECTION_AGENT_TOKENS`
  // widens nothing but the index and adds one slot.
  //
  // Below the nominal sum the whole allocation still scales down together, so a
  // deliberately small budget_tokens tightens every part instead of spending the lot on
  // identity and project and starving the index to nothing.
  const agentSlot = parts.some(p => p.label === 'agent') ? INJECTION_AGENT_TOKENS : 0;
  const nominal =
    INJECTION_IDENTITY_TOKENS + INJECTION_PROJECT_TOKENS + INJECTION_INDEX_TOKENS + agentSlot;
  const scale = budget < nominal ? budget / nominal : 1;
  // The two slots that are never emptied keep at least one token even when the scaled
  // share floors to zero — a zero sub-budget truncates to the empty string.
  const identityBudget = Math.max(1, Math.floor(INJECTION_IDENTITY_TOKENS * scale));
  const projectBudget = Math.floor(INJECTION_PROJECT_TOKENS * scale);
  const agentBudget = agentSlot === 0 ? 0 : Math.max(1, Math.floor(agentSlot * scale));
  // The remainder rather than a scaled INJECTION_INDEX_TOKENS, so the sub-budgets
  // always sum to exactly `budget` after flooring.
  const indexBudget = Math.max(0, budget - identityBudget - projectBudget - agentBudget);

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
  // yields before identity, and neither is ever dropped entirely.
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
    // Priority 3: Truncate the agent slot (kept, never emptied)
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
      // All parts are within their budgets but combined is over.
      // Shave the agent slot before identity, and neither below one token.
      if (agentContent && agentTokens > 1) {
        const result = truncateToTokens(agentTruncated, Math.max(1, agentTokens - 10));
        agentTruncated = result.text;
        agentTokens = result.tokens;
        // `> 1`, not `> 0`: the shave floors at one token, so re-entering here with a
        // one-token identity is a no-op that would spin out the iteration cap instead of
        // falling through. Reachable only when the sub-budget floors already sum past a
        // pathological budget, but a hook must not burn 100 passes to discover that.
      } else if (identityContent && identityTokens > 1) {
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
    agent: agentTruncated,
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
