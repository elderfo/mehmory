import {
  runHook
} from "./chunk-SQTSFCAP.mjs";
import {
  appendInboxEntries,
  inspectSession,
  isPaused,
  matchPages,
  openProjectWiki,
  rememberEntry,
  rememberTopic,
  scopePaths,
  staleSessionStartWarning,
  tokenize,
  topicCacheHit
} from "./chunk-2OY3T25E.mjs";
import "./chunk-ZQKNVQBL.mjs";

// src/hooks/user-prompt-submit.ts
var REMEMBER_PREFIX = /^remember:\s*/i;
var MAX_POINTERS = 3;
runHook("UserPromptSubmit", (input, project, host, config) => {
  if (!config.hooks.user_prompt_submit.enabled || isPaused(input.session_id)) return {};
  const prompt = input.prompt ?? "";
  const paths = scopePaths(project);
  const remember = REMEMBER_PREFIX.exec(prompt);
  if (remember) {
    const text = prompt.slice(remember[0].length);
    if (!text.trim()) return {};
    const entry = rememberEntry(text, input.session_id, host, config);
    const { appended } = appendInboxEntries(paths.inboxFile, [entry], project);
    return { context: "mehmory: captured to inbox", stats: { captured_entries: appended } };
  }
  const tokens = tokenize(prompt);
  const thresholds = { jaccard: config.match.jaccard, ttlMs: config.match.cache_ttl_ms };
  if (topicCacheHit(inspectSession(input.session_id).state, tokens, Date.now(), thresholds)) {
    return { stats: { pointers_offered: 0, topic_cache_hit: true } };
  }
  const wiki = openProjectWiki(project, { staleAfterDays: config.decay.archive_days });
  const pages = tokens.size === 0 ? [] : matchPages(prompt, wiki.pages, MAX_POINTERS);
  rememberTopic(input.session_id, tokens);
  const lines = pages.map((page) => `relevant: ${page.path}${page.stale ? " (stale)" : ""}`);
  const warning = staleSessionStartWarning(project);
  if (warning !== void 0) lines.push(`mehmory: ${warning}`);
  return { context: lines.join("\n"), stats: { pointers_offered: pages.length } };
});
