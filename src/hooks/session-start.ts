/**
 * SessionStart hook: inject memory, then do bounded housekeeping (criteria 7–9).
 *
 * Two lanes (A16). The response lane — auto-init, the wiki injection, at most two
 * maintenance lines — always runs. The maintenance lane — decay, one queued job, the
 * session-state sweep — runs only if it can do so uncontended, and silently skips
 * otherwise; the next session picks it up.
 */

import { mehmoryHome } from '../core/home.js';
import { loadConfig, type MehmoryConfig } from '../core/config.js';
import { pendingWarnings } from '../core/errors.js';
import { runHook } from '../core/hook.js';
import { isPaused, sweepSessionState } from '../core/session.js';
import { readInboxEntries } from '../core/inbox.js';
import { initStore } from '../core/store.js';
import { decayPass } from '../core/decay.js';
import { tryProjectLock } from '../core/lock.js';
import { claimJob, completeJob } from '../core/queue.js';
import { estimateTokens } from '../core/tokens.js';
import {
  applyDistillJob,
  buildScopeInjection,
  finalizePendingSessions,
  inboxBytes,
  scopePaths,
  storeExists,
  storeIsUnpopulated,
} from '../core/capture.js';
import type { Host } from '../core/host.js';

/** Maintenance-line allowance (U4 / spec gap 14): 2 lines, ~150 tokens. */
const MAX_MAINTENANCE_LINES = 2;

/**
 * Run the best-effort lane. Every step yields rather than waits (A16).
 *
 * Pending finalization goes first, ahead of both the queue drain — so a session finalized
 * here has its delta applied in the same start rather than the next one — and the state
 * sweep, which would otherwise be free to delete a pending session's state before anyone
 * read it (issue #24).
 *
 * @returns number of abandoned sessions finalized
 */
function maintenance(
  sessionId: string,
  project: string,
  host: Host,
  config: MehmoryConfig
): number {
  const finalized = finalizePendingSessions(sessionId, project, host, config);

  tryProjectLock(project, () => decayPass(scopePaths(project).projectDir));

  for (let claimed = 0; claimed < config.queue.claims_per_start; claimed++) {
    const job = claimJob('distill-final');
    if (!job) break;
    applyDistillJob(job.data);
    completeJob(job.id);
  }

  sweepSessionState();
  return finalized;
}

runHook('SessionStart', (input, project, host) => {
  const config = loadConfig();
  if (!config.hooks.session_start.enabled || isPaused(input.session_id)) return {};

  const justInitialized = !storeExists() && initStore().ok;
  const paths = scopePaths(project);
  const injection = buildScopeInjection(project);
  const entries = readInboxEntries(paths.inboxFile);
  const bytes = inboxBytes(paths.inboxFile);

  // Priority order is fixed: warning > compact notice > nudge > init notice.
  const candidates: string[] = [];
  const warning = pendingWarnings()[0];
  if (warning !== undefined) candidates.push(`mehmory: ${warning}`);
  if (input.source === 'compact') {
    candidates.push(
      `mehmory: context was compacted — what came before is captured in ${paths.inboxFile}; run /mehmory:integrate to merge it`
    );
  }
  if (entries.length >= config.inbox.nudge_entries || bytes >= config.inbox.nudge_bytes) {
    candidates.push(
      `mehmory: inbox has ${String(entries.length)} entries — run /mehmory:integrate`
    );
  }
  if (justInitialized || storeIsUnpopulated(project)) {
    candidates.push(
      `mehmory: memory at ${mehmoryHome()} is empty — run /mehmory:onboard-session to seed it`
    );
  }

  const lines = candidates.slice(0, MAX_MAINTENANCE_LINES);
  const context = [injection.text, ...lines].filter(Boolean).join('\n');

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
