/**
 * SessionStart hook: inject memory, then do bounded housekeeping (criteria 7–9).
 *
 * Two lanes (A16). The response lane — auto-init, the wiki injection, at most two
 * maintenance lines — always runs. The maintenance lane — decay, one queued job, the
 * session-state sweep — runs only if it can do so uncontended, and silently skips
 * otherwise; the next session picks it up.
 */

import assert from 'node:assert/strict';
import { mehmoryHome } from '../core/home.js';
import type { MehmoryConfig } from '../core/config.js';
import { logError, pendingWarnings } from '../core/errors.js';
import { runHook } from '../core/hook.js';
import { isPaused } from '../core/session.js';
import { maintainSessions } from '../core/session-lifecycle.js';
import { readInboxEntries } from '../core/inbox.js';
import { initStore } from '../core/store.js';
import { decayPass } from '../core/decay.js';
import { tryProjectLock } from '../core/lock.js';
import { claimJob, completeJob } from '../core/queue.js';
import { estimateTokens, MAINTENANCE_ALLOWANCE_TOKENS } from '../core/tokens.js';
import { truncateToTokens } from '../core/injection.js';
import {
  applyDistillJobResult,
  buildScopeInjection,
  inboxBytes,
  scopePaths,
  storeExists,
  skillRef,
  storeIsUnpopulated,
} from '../core/capture.js';
import type { Host } from '../core/host.js';

/** Maintenance-line allowance (U4 / spec gap 14): 2 lines, ~150 tokens. */
const MAX_MAINTENANCE_LINES = 2;

/**
 * Run the best-effort lane. Every step yields rather than waits (A16).
 *
 * The lifecycle module recovers pending tails before sweeping their state (issue #24).
 * The queue drain claims at most `queue.claims_per_start` jobs — 1 by default.
 *
 * @returns number of abandoned sessions finalized
 */
function maintenance(
  sessionId: string,
  project: string,
  host: Host,
  config: MehmoryConfig
): number {
  const { finalized } = maintainSessions(sessionId, project, host, config);

  tryProjectLock(project, () => decayPass(scopePaths(project).projectDir));

  for (let claimed = 0; claimed < config.queue.claims_per_start; claimed++) {
    const job = claimJob('distill-final');
    if (!job) break;
    try {
      const result = applyDistillJobResult(job.data, config);
      if (result.failed === 0) completeJob(job.id, job.claimFile);
    } catch (err) {
      logError({
        code: 'E_QUEUE_CLAIM',
        kind: 'informational',
        what: err instanceof Error ? err.message : String(err),
        consequence: 'The queued job remains for stale recovery',
      });
    }
  }

  return finalized;
}

runHook('SessionStart', (input, project, host, config) => {
  if (!config.hooks.session_start.enabled) return {};

  if (isPaused(input.session_id)) return {};

  const justInitialized = !storeExists() && initStore().ok;
  const paths = scopePaths(project);
  const injection = buildScopeInjection(project, config, input.session_id);
  const entries = readInboxEntries(paths.inboxFile);
  const bytes = inboxBytes(paths.inboxFile);

  // Priority order is fixed: warning > compact notice > nudge > init notice.
  const candidates: string[] = [];
  const warning = pendingWarnings(1)[0];
  if (warning !== undefined) candidates.push(`mehmory: ${warning}`);
  // Every maintenance line names a skill, and how a skill is invoked is harness-specific
  // — a Codex user has no slash commands to run (F3-4).
  const integrate = skillRef(host, 'integrate');
  if (input.source === 'compact') {
    candidates.push(
      `mehmory: context was compacted — what came before is captured in ${paths.inboxFile}; run ${integrate} to merge it`
    );
  }
  if (entries.length >= config.inbox.nudge_entries || bytes >= config.inbox.nudge_bytes) {
    candidates.push(`mehmory: inbox has ${String(entries.length)} entries — run ${integrate}`);
  }
  if (justInitialized || storeIsUnpopulated(project)) {
    candidates.push(
      `mehmory: memory at ${mehmoryHome()} is empty — run ${skillRef(host, 'onboard-session')} to seed it`
    );
  }

  const selected = candidates.slice(0, MAX_MAINTENANCE_LINES);
  const lines: string[] = [];
  let remaining = MAINTENANCE_ALLOWANCE_TOKENS;
  for (const [index, line] of selected.entries()) {
    // Reserve separators and a share for the next notice, even when a warning is long.
    const allowance = Math.floor(remaining / (selected.length - index));
    const text = truncateToTokens(line, allowance - 1).text;
    lines.push(text);
    remaining -= estimateTokens(text) + 1;
  }
  const context = [injection.text, ...lines].filter(Boolean).join('\n');
  assert(lines.length <= MAX_MAINTENANCE_LINES);
  assert(estimateTokens(context) <= config.injection.budget_tokens + MAINTENANCE_ALLOWANCE_TOKENS);

  const finalized = maintenance(input.session_id, project, host, config);

  return {
    context,
    stats: {
      injected_tokens: estimateTokens(context),
      inbox_bytes: bytes,
      maintenance_lines: lines.length,
      finalized_sessions: finalized,
    },
  };
});
