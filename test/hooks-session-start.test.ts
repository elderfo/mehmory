/** SessionStart fixture tests (criteria 7, 8, 9, 16, 19). */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import {
  additionalContext,
  errorsLog,
  keyFor,
  paths,
  runHook,
  seedStore,
  statsLines,
} from './hook-fixture.js';
import { mehmoryHome, statePath } from '../src/core/home.js';
import { recordWarning } from '../src/core/errors.js';
import { enqueueJob } from '../src/core/queue.js';
import { setPaused, sessionStatePath } from '../src/core/session.js';
import { estimateTokens } from '../src/core/tokens.js';
import { inboxEntryId } from '../src/schema/format.js';

const AGED_PAGE = `---
updated: 2020-01-01
type: decision
decay: default
---

# Ancient

- decided long ago
`;

describe('SessionStart hook', () => {
  let cwd: string;
  let key: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
  });

  it('injects the framed wiki for a populated store and records a stats line', () => {
    seedStore(key, {
      project: '---\nupdated: 2026-07-01\ntype: entity\n---\n\n# Project\n\n- stack: rust\n',
      pages: { 'deploy.md': '# Deploy\n\n- ship via fly.io\n' },
      index: '# Index\n\n- [[deploy]] — how we ship\n',
    });

    const run = runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd });
    const context = additionalContext(run);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(context).toContain('<mehmory-memory>');
    expect(context).toContain('stack: rust');
    expect(context).toContain('[[deploy]]');

    const stat = statsLines().at(-1);
    expect(stat).toMatchObject({ project: key, hook: 'SessionStart' });
    expect(typeof stat?.['ms']).toBe('number');
    expect(typeof stat?.['injected_tokens']).toBe('number');
  });

  it('auto-initializes a missing store and points at onboarding', () => {
    const run = runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd });

    expect(run.status).toBe(0);
    expect(existsSync(join(mehmoryHome(), 'global', 'identity.md'))).toBe(true);
    expect(additionalContext(run)).toContain('/mehmory:onboard-session');
    expect(additionalContext(run)).not.toContain('mehmory init');
  });

  it('still injects the identity frame for an initialized-but-empty store', () => {
    seedStore(key, { project: '', index: '' });

    const context = additionalContext(
      runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd })
    );

    expect(context).toContain('# identity');
    expect(context).toContain('/mehmory:onboard-session');
  });

  it('nudges when the inbox passes the entry threshold', () => {
    seedStore(key, { inboxEntries: 12 });

    const context = additionalContext(
      runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd })
    );

    expect(context).toContain('inbox has 12 entries');
    expect(context).toContain('/mehmory:integrate');
  });

  it('names the inbox and integrate on the compact matcher', () => {
    seedStore(key);

    const context = additionalContext(
      runHook('session-start', { session_id: 's1', source: 'compact' }, { cwd })
    );

    expect(context).toContain('compacted');
    expect(context).toContain(paths(key).inbox);
    expect(context).toContain('/mehmory:integrate');
  });

  it('emits at most 2 maintenance lines and stays under 950 tokens in the worst case', () => {
    // Warning + compact + nudge + empty store all fire at once.
    seedStore(key, { inboxEntries: 30, project: '', index: 'x'.repeat(4000) });
    recordWarning('E_CONFIG_PARSE');

    const context = additionalContext(
      runHook('session-start', { session_id: 's1', source: 'compact' }, { cwd })
    );

    const maintenance = context.split('\n').filter(line => line.startsWith('mehmory: '));
    expect(maintenance).toHaveLength(2);
    expect(maintenance[0]).toContain('E_CONFIG_PARSE');
    expect(maintenance[1]).toContain('compacted');
    expect(estimateTokens(context)).toBeLessThanOrEqual(950);
  });

  it('emits nothing at all when the session is paused', () => {
    seedStore(key, { inboxEntries: 30 });
    setPaused('s1', true);

    const run = runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('emits nothing when the hook is disabled in config', () => {
    seedStore(key);
    writeFileSync(
      join(mehmoryHome(), 'config.json'),
      JSON.stringify({ hooks: { session_start: { enabled: false } } })
    );

    expect(runHook('session-start', { session_id: 's1' }, { cwd }).stdout).toBe('');
  });

  it('runs the decay pass on the maintenance lane', () => {
    seedStore(key, { pages: { 'ancient.md': AGED_PAGE }, index: '# Index\n\n- [[ancient]]\n' });

    runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd });

    expect(existsSync(join(paths(key).projectDir, 'archive', 'ancient.md'))).toBe(true);
  });

  it('skips decay but still injects when the project lock is held', () => {
    seedStore(key, { pages: { 'ancient.md': AGED_PAGE }, index: '# Index\n\n- [[ancient]]\n' });
    const lockDir = statePath('locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `${key.replace(/\//g, '_')}.lock`), String(process.pid));

    const context = additionalContext(
      runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd })
    );

    expect(context).toContain('<mehmory-memory>');
    expect(existsSync(join(paths(key).projectDir, 'archive', 'ancient.md'))).toBe(false);
    expect(existsSync(join(paths(key).pages, 'ancient.md'))).toBe(true);
  });

  it('claims and applies one queued distill-final job, leaving the queue empty', () => {
    seedStore(key);
    enqueueJob(
      {
        key,
        entries: [
          {
            id: inboxEntryId('queued-1'),
            text: 'queued learning',
            src: 'prior-session',
            ts: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      'distill-final'
    );

    runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd });

    expect(readFileSync(paths(key).inbox, 'utf-8')).toContain('queued learning');

    const queueDir = statePath('queue');
    const jsonIn = (dir: string): string[] =>
      existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    expect(jsonIn(queueDir)).toEqual([]);
    expect(jsonIn(join(queueDir, 'claimed'))).toEqual([]);
  });

  it('sweeps session-state files past the age bound', () => {
    seedStore(key);
    const stale = sessionStatePath('ancient-session');
    mkdirSync(statePath(), { recursive: true });
    writeFileSync(
      stale,
      JSON.stringify({
        session_id: 'ancient-session',
        cursor: { file_id: '', size: 0, offset: 0 },
        stop_count: 0,
        paused: false,
      })
    );
    const longAgo = Date.now() / 1000 - 60 * 60 * 24 * 30;
    utimesSync(stale, longAgo, longAgo);

    runHook('session-start', { session_id: 's1', source: 'startup' }, { cwd });

    expect(existsSync(stale)).toBe(false);
    expect(errorsLog()).not.toContain('E_STORE_INIT');
  });
});
