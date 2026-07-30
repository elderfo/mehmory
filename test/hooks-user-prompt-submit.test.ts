/** UserPromptSubmit fixture tests (criteria 10, 14, 16, 19). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTempDir } from './helpers.js';
import {
  additionalContext,
  keyFor,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
} from './hook-fixture.js';
import { recordWarning } from '../src/core/errors.js';
import { recordStat } from '../src/core/stats.js';
import { setPaused } from '../src/core/session.js';

const DEPLOY_PAGE = `---
updated: 2026-07-01
type: procedure
---

# Deployment runbook

- deployment runs through the fly.io pipeline
- rollback is a redeploy of the previous release
`;

describe('UserPromptSubmit hook', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key, { pages: { 'deployment.md': DEPLOY_PAGE } });
  });

  it('offers pointers for a matching prompt', () => {
    const run = runHook(
      'user-prompt-submit',
      { session_id: 's1', prompt: 'how does deployment rollback work?' },
      { cwd }
    );

    expect(run.status).toBe(0);
    expect(additionalContext(run)).toContain('relevant: pages/deployment.md');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'UserPromptSubmit', pointers_offered: 1 });
  });

  it('stays silent when nothing matches', () => {
    const run = runHook(
      'user-prompt-submit',
      { session_id: 's1', prompt: 'what is the airspeed velocity of a swallow' },
      { cwd }
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('skips the lookup on a topic-cache hit', () => {
    const prompt = 'how does deployment rollback work?';
    runHook('user-prompt-submit', { session_id: 's1', prompt }, { cwd });

    const second = runHook('user-prompt-submit', { session_id: 's1', prompt }, { cwd });

    expect(second.stdout).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ topic_cache_hit: true });
  });

  it('captures a `remember:` prompt, redacted, and acknowledges it', () => {
    const run = runHook(
      'user-prompt-submit',
      {
        session_id: 's1',
        prompt: 'remember: the deploy key is AKIAIOSFODNN7EXAMPLE and must stay secret',
      },
      { cwd }
    );

    expect(additionalContext(run)).toBe('mehmory: captured to inbox');
    const inbox = readIfPresent(paths(key).inbox);
    expect(inbox).toContain('the deploy key is');
    expect(inbox).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(inbox).toContain('src=s1');
    expect(statsLines().at(-1)).toMatchObject({ captured_entries: 1 });
  });

  it('drains one pending warning when SessionStart has not reported', () => {
    recordWarning('E_CONFIG_PARSE');

    const context = additionalContext(
      runHook('user-prompt-submit', { session_id: 's1', prompt: 'unrelated question' }, { cwd })
    );

    expect(context).toContain('E_CONFIG_PARSE');
  });

  it('leaves warning delivery to SessionStart when it reported recently', () => {
    recordWarning('E_CONFIG_PARSE');
    recordStat({ project: key, hook: 'SessionStart', ms: 3 });

    const run = runHook(
      'user-prompt-submit',
      { session_id: 's1', prompt: 'unrelated question' },
      { cwd }
    );

    expect(run.stdout).toBe('');
  });

  it('emits nothing at all when the session is paused', () => {
    setPaused('s1', true);

    const run = runHook(
      'user-prompt-submit',
      { session_id: 's1', prompt: 'how does deployment rollback work?' },
      { cwd }
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });
});
