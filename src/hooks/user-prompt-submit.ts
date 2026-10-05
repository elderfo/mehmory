/**
 * UserPromptSubmit hook: pointers, explicit capture, warning drain (criterion 10).
 *
 * Three mutually exclusive outcomes. `remember: <text>` captures and acknowledges (the
 * prompt itself passes through untouched — this hook cannot rewrite it, U5). Otherwise
 * a grep match over the scope's pages offers at most 3 pointers, suppressed by the
 * topic cache when the prompt has not really changed topic. No match, no output.
 */

import { openProjectWiki, scopePaths } from '../core/wiki.js';
import { runHook } from '../core/hook.js';
import { appendInboxEntries } from '../core/inbox.js';
import { matchPages, tokenize } from '../core/match.js';
import { isPaused, readSessionState, rememberTopic, topicCacheHit } from '../core/session.js';
import { rememberEntry, staleSessionStartWarning } from '../core/capture.js';

/** Prefix that turns a prompt into an explicit inbox capture (gate item T2). */
const REMEMBER_PREFIX = /^remember:\s*/i;

/** Pointer lines offered per prompt. */
const MAX_POINTERS = 3;

runHook('UserPromptSubmit', (input, project, host, config) => {
  if (!config.hooks.user_prompt_submit.enabled || isPaused(input.session_id)) return {};

  const prompt = input.prompt ?? '';
  const paths = scopePaths(project);

  const remember = REMEMBER_PREFIX.exec(prompt);
  if (remember) {
    const text = prompt.slice(remember[0].length);
    if (!text.trim()) return {};
    const entry = rememberEntry(text, input.session_id, host, config);
    const { appended } = appendInboxEntries(paths.inboxFile, [entry], project);
    return { context: 'mehmory: captured to inbox', stats: { captured_entries: appended } };
  }

  const tokens = tokenize(prompt);
  // Thresholds come from the config this hook already loaded — topicCacheHit would
  // otherwise re-read and re-parse it on the hot path.
  const thresholds = { jaccard: config.match.jaccard, ttlMs: config.match.cache_ttl_ms };
  if (topicCacheHit(readSessionState(input.session_id), tokens, Date.now(), thresholds)) {
    return { stats: { pointers_offered: 0, topic_cache_hit: true } };
  }

  const wiki = openProjectWiki(project, { staleAfterDays: config.decay.archive_days });
  const pages = tokens.size === 0 ? [] : matchPages(prompt, wiki.pages, MAX_POINTERS);
  rememberTopic(input.session_id, tokens);

  // A stale pointer is still offered — demoted in ranking, and labeled so the model
  // knows to treat it as possibly out of date rather than silently trusting it.
  const lines = pages.map((page) => `relevant: ${page.path}${page.stale ? ' (stale)' : ''}`);
  const warning = staleSessionStartWarning(project);
  if (warning !== undefined) lines.push(`mehmory: ${warning}`);

  return { context: lines.join('\n'), stats: { pointers_offered: pages.length } };
});
