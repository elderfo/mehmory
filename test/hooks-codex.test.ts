/**
 * Codex host end-to-end: recall (#22) and capture (#23) through the built bundles.
 *
 * Every payload here is the shape Codex CLI 0.146.0 was measured to send
 * (`.research/codex-spike/VERDICT.md`, `payloads/*.json`): `transcript_path` on every
 * event, `turn_id`/`model`/`permission_mode` alongside, and `argv[2] === 'codex'` with
 * the installer's trailing `--mehmory` ownership marker that adapters must ignore.
 *
 * The point of the suite is that one store serves two harnesses: the same bundles, the
 * same project key, the same inbox — only the reader and the `host=` attribution differ.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTempDir } from './helpers.js';
import {
  additionalContext,
  keyFor,
  outputJson,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeCodexRollout,
  writeTranscript,
} from './hook-fixture.js';
import { setPaused, updateSessionState } from '../src/core/session.js';
import { loadConfig } from '../src/core/config.js';
import { estimateTokens } from '../src/core/tokens.js';
import { parseInboxEntries } from '../src/schema/format.js';

/** The arguments `mehmory init --codex` writes: host first, ownership marker after. */
const CODEX_ARGS = ['codex', '--mehmory'] as const;

/** A real rollout uuid from the captured payloads — Codex reports it as `session_id`. */
const CODEX_SESSION = '019fbf44-4f17-7a53-8914-1002bc65fbae';

const CODEX_TURN = '019fbf44-51af-7693-a39d-3b7b66c5c195';

const DEPLOY_PAGE = `---
updated: 2026-07-01
type: procedure
---

# Deployment runbook

- deployment runs through the fly.io pipeline
- rollback is a redeploy of the previous release
`;

/** Past `decay.archive_days` (60), so A22 demotion and the `(stale)` flag apply. */
const AGED_PAGE = `---
updated: 2020-01-01
type: procedure
---

# Deployment runbook

- deployment runs through the fly.io pipeline
- rollback is a redeploy of the previous release
`;

const ROLLOUT = [
  { text: 'We decided to use fly.io for deploys.' },
  { text: 'Actually the rollback step was wrong; redeploy the previous release instead.' },
  { text: 'The staging key AKIAIOSFODNN7EXAMPLE is in the env file.' },
];

/** The measured SessionStart payload. */
function sessionStart(cwd: string, transcriptPath: string, source = 'startup'): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: 'SessionStart',
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    source,
  };
}

/** The measured UserPromptSubmit payload. */
function userPromptSubmit(cwd: string, transcriptPath: string, prompt: string): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    turn_id: CODEX_TURN,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    prompt,
  };
}

/** The measured Stop payload, including the explicit `stop_hook_active: false`. */
function stop(cwd: string, transcriptPath: string, stopHookActive = false): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    turn_id: CODEX_TURN,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: 'Stop',
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    stop_hook_active: stopHookActive,
    last_assistant_message: 'done',
  };
}

function stopThreshold(): number {
  return loadConfig().stop.capture_threshold;
}

/** Put the session one Stop away from the capture threshold. */
function primeCounter(sessionId: string): void {
  updateSessionState(sessionId, state => ({ ...state, stop_count: stopThreshold() - 1 }));
}

describe('Codex recall (#22)', () => {
  let cwd: string;
  let key: string;
  let rollout: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, { pages: { 'deployment.md': DEPLOY_PAGE } });
    rollout = writeCodexRollout(ROLLOUT, CODEX_SESSION);
  });

  it('injects the memory frame and routing block at session start', () => {
    const run = runHook('session-start', sessionStart(cwd, rollout), { cwd, args: CODEX_ARGS });
    const context = additionalContext(run);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(context).toContain('<mehmory-memory>');
    expect(context).toContain(`# project ${key}`);
    expect(context).toContain('<mehmory-routing>');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'SessionStart', host: 'codex' });
  });

  it('names the Codex skill, not a Claude Code slash command, in its maintenance lines (F3-4)', () => {
    seedStore(key, { inboxEntries: 30 });

    const codex = additionalContext(
      runHook('session-start', sessionStart(cwd, rollout, 'compact'), { cwd, args: CODEX_ARGS })
    );

    expect(codex).toContain('mehmory-integrate');
    expect(codex).not.toContain('/mehmory:');

    // The Claude Code wording is unchanged — this is host-shaped guidance, not a rename.
    const claude = additionalContext(
      runHook(
        'session-start',
        { session_id: 'claude-session', transcript_path: writeTranscript(ROLLOUT), source: 'compact' },
        { cwd, args: ['claude-code'] }
      )
    );
    expect(claude).toContain('/mehmory:integrate');
  });

  it('resolves the same project key as Claude Code in the same repository (A5)', () => {
    const codex = runHook('session-start', sessionStart(cwd, rollout), { cwd, args: CODEX_ARGS });
    const claude = runHook(
      'session-start',
      { session_id: 'claude-session', transcript_path: writeTranscript(ROLLOUT), source: 'startup' },
      { cwd, args: ['claude-code'] }
    );

    // Identical injected project heading — the key, not just the text, is shared.
    expect(additionalContext(codex)).toContain(`# project ${key}`);
    expect(additionalContext(claude)).toContain(`# project ${key}`);
    const [codexStat, claudeStat] = statsLines().slice(-2);
    expect(codexStat).toMatchObject({ project: key, host: 'codex' });
    expect(claudeStat).toMatchObject({ project: key, host: 'claude-code' });
  });

  it('obeys the same session-start token budget as Claude Code', () => {
    seedStore(key, { inboxEntries: 30, project: '', index: 'x'.repeat(4000) });

    const context = additionalContext(
      runHook('session-start', sessionStart(cwd, rollout, 'compact'), { cwd, args: CODEX_ARGS })
    );

    expect(estimateTokens(context)).toBeLessThanOrEqual(950);
  });

  it('stays inside the existing sub-second session-start latency budget', () => {
    runHook('session-start', sessionStart(cwd, rollout), { cwd, args: CODEX_ARGS });

    // `ms` is measured inside the hook process, so it excludes spawn cost — the same
    // number the Claude Code path records, against the same <1 s budget (criterion 13).
    const ms = statsLines().at(-1)?.['ms'];
    expect(typeof ms).toBe('number');
    expect(ms).toBeLessThan(1000);
  });

  it('offers pointers for a matching prompt', () => {
    const run = runHook(
      'user-prompt-submit',
      userPromptSubmit(cwd, rollout, 'how does deployment rollback work?'),
      { cwd, args: CODEX_ARGS }
    );

    expect(run.status).toBe(0);
    expect(additionalContext(run)).toContain('relevant: pages/deployment.md');
    expect(statsLines().at(-1)).toMatchObject({
      hook: 'UserPromptSubmit',
      host: 'codex',
      pointers_offered: 1,
    });
  });

  it('demotes aged memory with a flag rather than excluding it (A22)', () => {
    seedStore(key, { pages: { 'deployment.md': AGED_PAGE } });

    const context = additionalContext(
      runHook('user-prompt-submit', userPromptSubmit(cwd, rollout, 'how does deployment rollback work?'), {
        cwd,
        args: CODEX_ARGS,
      })
    );

    expect(context).toContain('relevant: pages/deployment.md (stale)');
  });

  it('suppresses injection on both events while paused', () => {
    setPaused(CODEX_SESSION, true);

    const start = runHook('session-start', sessionStart(cwd, rollout), { cwd, args: CODEX_ARGS });
    const submit = runHook(
      'user-prompt-submit',
      userPromptSubmit(cwd, rollout, 'how does deployment rollback work?'),
      { cwd, args: CODEX_ARGS }
    );

    expect(start.stdout).toBe('');
    expect(submit.stdout).toBe('');
    expect(start.status).toBe(0);
    expect(submit.status).toBe(0);
  });

  it('never breaks the session on a malformed payload or a missing rollout (A2, A8)', () => {
    for (const input of [
      { not: 'a hook payload' },
      { session_id: CODEX_SESSION, transcript_path: '/nope/missing.jsonl', prompt: 'hello' },
      { session_id: '', prompt: 'hello' },
    ]) {
      const run = runHook('user-prompt-submit', input, { cwd, args: CODEX_ARGS });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
    }
  });

  it('ignores the installer ownership marker rather than reading it as the host', () => {
    runHook('user-prompt-submit', userPromptSubmit(cwd, rollout, 'hello'), {
      cwd,
      args: ['codex', '--mehmory'],
    });

    expect(statsLines().at(-1)).toMatchObject({ host: 'codex' });
  });
});

describe('Codex capture (#23)', () => {
  let cwd: string;
  let key: string;
  let rollout: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, { pages: { 'deployment.md': DEPLOY_PAGE } });
    rollout = writeCodexRollout(ROLLOUT, CODEX_SESSION);
  });

  it('captures the `remember:` prefix inline, attributed to codex', () => {
    const run = runHook(
      'user-prompt-submit',
      userPromptSubmit(cwd, rollout, 'remember: staging deploys need the VPN'),
      { cwd, args: CODEX_ARGS }
    );

    expect(additionalContext(run)).toBe('mehmory: captured to inbox');
    const entries = parseInboxEntries(readIfPresent(paths(key).inbox));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: 'staging deploys need the VPN',
      src: CODEX_SESSION,
      host: 'codex',
    });
  });

  it('distills the rollout at the stop threshold into the same inbox and scope', () => {
    primeCounter(CODEX_SESSION);

    const run = runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS });

    expect(run.status).toBe(0);
    const entries = parseInboxEntries(readIfPresent(paths(key).inbox));
    expect(entries.length).toBeGreaterThan(0);
    // Every entry is attributed to codex — the D1 failure mode is a silent claude-code
    // default, which would still produce a well-formed line.
    expect(entries.every(entry => entry.host === 'codex')).toBe(true);
    expect(entries.some(entry => entry.text.includes('fly.io'))).toBe(true);
    expect(statsLines().at(-1)).toMatchObject({ hook: 'Stop', host: 'codex' });
  });

  it('redacts secrets in a Codex capture exactly as in a Claude Code one', () => {
    // The secret is embedded in a line that IS captured, not one the distiller drops:
    // absence alone would otherwise prove nothing about the filter, only about the
    // classifier. The surrounding words must survive, the key must not.
    const secretRollout = writeCodexRollout(
      [{ text: 'We decided to deploy with the key AKIAIOSFODNN7EXAMPLE from the env file.' }],
      CODEX_SESSION
    );
    primeCounter(CODEX_SESSION);

    runHook('stop', stop(cwd, secretRollout), { cwd, args: CODEX_ARGS });

    const inbox = readIfPresent(paths(key).inbox);
    expect(inbox).toContain('We decided to deploy with the key');
    expect(inbox).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(inbox).toContain('[REDACTED]');
  });

  it('takes only the event_msg stream, so a user turn is not filed twice', () => {
    primeCounter(CODEX_SESSION);

    runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS });

    const texts = parseInboxEntries(readIfPresent(paths(key).inbox)).map(entry => entry.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('blocks with the shape Codex accepts, and never the hookSpecificOutput envelope', () => {
    primeCounter(CODEX_SESSION);

    const output = outputJson(runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS }));

    // Measured: `{hookSpecificOutput:{…}}` on Stop is rejected outright by Codex with
    // `hook returned invalid stop hook JSON output`. Only `{}` or `{decision, reason}`.
    expect(Object.keys(output).sort()).toEqual(['decision', 'reason']);
    expect(output['decision']).toBe('block');
    expect(output).not.toHaveProperty('hookSpecificOutput');
  });

  it('fires the nudge once per threshold crossing and never loops on the guard', () => {
    primeCounter(CODEX_SESSION);
    expect(outputJson(runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS }))).toMatchObject({
      decision: 'block',
    });

    // The Stop our own block caused: guard set, so no counting and no second block.
    const guarded = runHook('stop', stop(cwd, rollout, true), { cwd, args: CODEX_ARGS });
    expect(guarded.stdout).toBe('{}');

    // And the next ordinary Stop is back at the bottom of the counter.
    const next = runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS });
    expect(next.stdout).toBe('{}');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'Stop', host: 'codex', stop_count: 1 });
  });

  it('suppresses capture while paused', () => {
    setPaused(CODEX_SESSION, true);
    primeCounter(CODEX_SESSION);

    const stopRun = runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS });
    const remember = runHook(
      'user-prompt-submit',
      userPromptSubmit(cwd, rollout, 'remember: this must not be captured'),
      { cwd, args: CODEX_ARGS }
    );

    expect(stopRun.stdout).toBe('{}');
    expect(remember.stdout).toBe('');
    expect(readIfPresent(paths(key).inbox)).toBe('');
  });

  it('interleaves with a Claude Code session on one project without corrupting the inbox', () => {
    const claudeSession = 'claude-session';
    const transcript = writeTranscript([{ text: 'We decided to pin the node version to 22.' }]);
    primeCounter(CODEX_SESSION);
    primeCounter(claudeSession);

    // Interleaved, not serialized: each harness's Stop lands between the other's.
    runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS });
    runHook(
      'stop',
      { session_id: claudeSession, transcript_path: transcript },
      { cwd, args: ['claude-code'] }
    );
    runHook(
      'user-prompt-submit',
      userPromptSubmit(cwd, rollout, 'remember: codex wrote this one'),
      { cwd, args: CODEX_ARGS }
    );

    const raw = readIfPresent(paths(key).inbox);
    const bodyLines = raw.split('\n').filter(line => line.startsWith('- '));
    const entries = parseInboxEntries(raw);

    // Nothing was interleaved mid-line: every `- ` line parsed, none were lost or merged.
    expect(entries).toHaveLength(bodyLines.length);
    expect(entries.filter(entry => entry.host === 'codex').length).toBeGreaterThan(0);
    expect(entries.filter(entry => entry.host === 'claude-code').length).toBeGreaterThan(0);
    expect(entries.some(entry => entry.text.includes('node version'))).toBe(true);
    expect(entries.some(entry => entry.text === 'codex wrote this one')).toBe(true);
  });

  it('captures without blocking or prompting in a non-interactive run', () => {
    // `codex exec` sends the same Stop payload; the block simply produces no follow-up
    // turn there (VERDICT (c)). Capture is what must survive — assert it does, from the
    // hook's own point of view, which is identical either way.
    primeCounter(CODEX_SESSION);

    const run = runHook('stop', stop(cwd, rollout), { cwd, args: CODEX_ARGS });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(parseInboxEntries(readIfPresent(paths(key).inbox)).length).toBeGreaterThan(0);
  });
});
