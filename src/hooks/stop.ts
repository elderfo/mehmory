/**
 * Stop hook: periodic deterministic capture plus one block-with-reason (criterion 11).
 *
 * Layer (a) is the transcript distill, which needs nothing from the model. Layer (b) is
 * the block: once per threshold crossing, the model is asked to write down what only it
 * knows. `stop_hook_active` guards the loop — a Stop caused by our own block never
 * counts and never blocks again.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook, type HookResult } from '../core/hook.js';
import { incrementStopCount, isPaused, resetStopCount } from '../core/session.js';
import { captureDelta, scopePaths, skillRef } from '../core/capture.js';
import type { InboxHost } from '../schema/format.js';

/** Directory this bundle runs from; `inbox-tx.mjs` is its sibling (A15). */
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The literal command that appends one entry without loading a skill first.
 *
 * Heredoc, not `echo '<json>' |`: the learning is model-written prose and a single
 * quote in it would end the shell quote and break the command. A quoted heredoc
 * delimiter passes the body through to stdin literally. Never the raw entry
 * serialization — ids are sha256, and A15 reserves inbox writes for the helper.
 */
function appendCommand(key: string, sessionId: string): string {
  const payload = JSON.stringify({
    inbox: scopePaths(key).inboxFile,
    key,
    entries: [{ text: '<the learning>', src: sessionId }],
  });
  const helper = `${HOOK_DIR}/inbox-tx.mjs`.replace(/'/g, `'\\''`);
  return `node '${helper}' append <<'JSON'\n${payload}\nJSON\n`;
}

/** How one host's Stop nudge is worded and delivered. */
interface StopNudge {
  /** Whether the reason embeds the literal `inbox-tx` command next to the skill reference. */
  readonly carriesCommand: boolean;
  /** The output shape that blocks this host's Stop most quietly. */
  readonly output: (reason: string) => HookResult;
}

/**
 * Claude Code gets the skill reference alone — `/mehmory:remember` ships in the same
 * plugin as the hook that is running, so a hook invocation is proof the skill is
 * installed. Codex additionally gets the literal `inbox-tx` command: skill invocation
 * there is not a first-class slash command, and the reason is the model's only
 * guaranteed executable path to the inbox.
 *
 * Both output shapes block. Claude Code funnels a hook's `additionalContext` into the same
 * `blockingErrors` array as a `decision: block` — the model is re-invoked and the next
 * Stop still carries `stop_hook_active`, so the loop guard is unaffected (verified
 * against 2.1.241). What differs is the transcript line: a block renders as
 * `Stop hook error: <reason>` plus an error toast, `additionalContext` as
 * `Stop hook feedback: <reason>` with no toast. This nudge is routine, not a failure,
 * so it takes the shape that does not claim otherwise (issue #47).
 *
 * Codex keeps `{decision, reason}`: the `hookSpecificOutput` envelope that is valid on
 * every other event is rejected outright on Codex's Stop (D9), so it is not a portable
 * default — only a Claude Code refinement.
 *
 * Pi's model cannot run a slash command either, so it gets the command; its Stop is the
 * mehmory extension, which turns `additionalContext` into a custom message (A29).
 */
const STOP_NUDGES = {
  'claude-code': { carriesCommand: false, output: reason => ({ context: reason }) },
  codex: { carriesCommand: true, output: reason => ({ json: { decision: 'block', reason } }) },
  pi: { carriesCommand: true, output: reason => ({ context: reason }) },
} satisfies Record<InboxHost, StopNudge>;

/**
 * The block reason (U6): fixed template naming what to save and one way to save it.
 *
 * Every host renders this text verbatim into the session transcript, so it stays as
 * short as the instruction allows.
 */
function blockReason(key: string, sessionId: string, host: InboxHost): string {
  const save = STOP_NUDGES[host].carriesCommand
    ? `Use ${skillRef(host, 'remember')}, or run:\n${appendCommand(key, sessionId)}`
    : `${skillRef(host, 'remember')} saves them.`;
  return [
    'mehmory: before stopping, append anything durable from this stretch —',
    'decisions, corrections, gotchas — as one short line each.',
    save,
    'Save silently: one short sentence, no recap of what you saved or where things stand,',
    'then stop. Nothing durable? Say so and stop. Fires once per threshold.',
  ].join(' ');
}

runHook('Stop', (input, project, host, config) => {
  if (input.stop_hook_active === true) return {};

  if (!config.hooks.stop.enabled || isPaused(input.session_id)) return {};

  const count = incrementStopCount(input.session_id);
  if (count < config.stop.capture_threshold) return { stats: { stop_count: count } };

  const captured = captureDelta(input.session_id, input.transcript_path, project, host, config);
  if ((captured.failed ?? 0) === 0) resetStopCount(input.session_id);

  return {
    ...STOP_NUDGES[host].output(blockReason(project, input.session_id, host)),
    stats: { stop_count: count, captured_entries: captured.appended },
  };
});
