import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { buildScopeInjection } from '../src/core/capture.js';
import { buildInjection } from '../src/core/injection.js';

import { runDoctor } from '../src/core/doctor.js';
import { inboxAgeMs } from '../src/core/status.js';
import { mehmoryHome } from '../src/core/home.js';
import { estimateTokens } from '../src/core/tokens.js';
import * as fs from '../src/core/fs.js';
import {
  additionalContext,
  keyFor,
  paths,
  runHook,
  seedStore,
  statsLines,
} from './hook-fixture.js';
import { createTempDir } from './helpers.js';

const KEY = 'regressions';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MEHMORY_AGENT'];
});

describe('retrieval and injection regressions', () => {
  it('offers directly readable project and global pointers from a repository cwd', () => {
    const cwd = createTempDir('pointer-cwd');
    const key = keyFor(cwd);
    seedStore(key, { pages: { 'deploy.md': '# Deploy\n' } });
    expect(
      additionalContext(
        runHook('user-prompt-submit', { session_id: 'project', prompt: 'deploy' }, { cwd })
      )
    ).toBe(`relevant: ${join(paths(key).pages, 'deploy.md')}`);
    rmSync(paths(key).pages, { recursive: true });
    writeFileSync(join(mehmoryHome(), 'global', 'pages', 'deploy.md'), '# Deploy\n');
    expect(
      additionalContext(
        runHook('user-prompt-submit', { session_id: 'global', prompt: 'deploy' }, { cwd })
      )
    ).toBe(`relevant: ${join(mehmoryHome(), 'global', 'pages', 'deploy.md')}`);
  });

  it('never cuts an emoji between its surrogate halves', () => {
    expect(
      buildInjection([{ label: 'identity', content: 'abc😀remaining' }], { budgetTokens: 1 })
        .identity
    ).toBe('abc');
  });

  it.each([128, 200, 400, 800, 2000, 8000])(
    'fits the complete named and unnamed memory frame into %i tokens',
    (budget) => {
      seedStore(KEY, { project: 'p'.repeat(40000), index: 'i'.repeat(40000) });
      writeFileSync(join(mehmoryHome(), 'global', 'identity.md'), 'u'.repeat(40000));
      mkdirSync(join(mehmoryHome(), 'agents', 'alpha'), { recursive: true });
      writeFileSync(join(mehmoryHome(), 'agents', 'alpha', 'identity.md'), 'a'.repeat(40000));
      const config = { ...loadConfig(), injection: { budget_tokens: budget } };
      for (const agent of ['', 'alpha']) {
        process.env['MEHMORY_AGENT'] = agent;
        const frame = buildScopeInjection(KEY, config, 'live-session');
        expect(frame.text).toContain('</mehmory-memory>');
        expect(frame.tokens).toBe(estimateTokens(frame.text));
        expect(frame.tokens).toBeLessThanOrEqual(budget);
      }
    }
  );

  it.each([
    [1, ''],
    [8, ''],
    [9, '<mehmory-memory></mehmory-memory>'],
  ] as const)('honors even a %i-token cap below the session framing cost', (budget, expected) => {
    seedStore(KEY);
    const config = { ...loadConfig(), injection: { budget_tokens: budget } };
    expect(buildScopeInjection(KEY, config, 'live-session').text).toBe(expected);
  });

  it.each([1, 8, 9, 128, 400, 800, 2000, 8000])(
    'caps the final SessionStart output including maintenance at %i tokens',
    (budget) => {
      const cwd = createTempDir('budget-cwd');
      const key = keyFor(cwd);
      seedStore(key, { project: 'p'.repeat(40000), index: 'i'.repeat(40000), inboxEntries: 30 });
      writeFileSync(join(mehmoryHome(), 'global', 'identity.md'), 'u'.repeat(40000));
      writeFileSync(
        join(mehmoryHome(), 'config.json'),
        JSON.stringify({ injection: { budget_tokens: budget } })
      );
      const context = additionalContext(
        runHook('session-start', { session_id: 'budget-session', source: 'compact' }, { cwd })
      );
      expect(context).toContain('context was compacted');
      if (budget >= 9) expect(context).toContain('</mehmory-memory>');
      expect(estimateTokens(context)).toBeLessThanOrEqual(budget + 150);
      expect(statsLines().at(-1)?.['injected_tokens']).toBe(estimateTokens(context));
    }
  );

  it('uses the configured injection budget for the doctor KPI', () => {
    seedStore(KEY);
    writeFileSync(
      join(mehmoryHome(), '.state', 'stats.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), project: KEY, hook: 'SessionStart', ms: 5, injected_tokens: 2150 })}\n`
    );
    const config = { ...loadConfig(), injection: { budget_tokens: 2000 } };
    expect(runDoctor(config, '>=22').find((f) => f.check === 'kpi.injection')).toBeUndefined();
    const lowerBudget = { ...config, injection: { budget_tokens: 1999 } };
    expect(runDoctor(lowerBudget, '>=22').find((f) => f.check === 'kpi.injection')?.message).toBe(
      'injected tokens p95 is 2150, over the 2149 combined budget'
    );
  });

  it.each(['SCHEMA.md', '.state/errors.log'])(
    'turns an unreadable %s check into an error finding without aborting doctor',
    (name) => {
      seedStore(KEY);
      const path = join(mehmoryHome(), name);
      rmSync(path, { force: true });
      mkdirSync(path);
      const check = name === 'SCHEMA.md' ? 'schema_version' : 'errors';
      expect(runDoctor(loadConfig(), '>=22').find((f) => f.check === check)?.level).toBe('error');
    }
  );

  it('reports a pages file as a doctor error rather than a healthy scope', () => {
    const cwd = createTempDir('doctor-cwd');
    const key = keyFor(cwd);
    seedStore(key);
    rmSync(paths(key).pages, { recursive: true });
    writeFileSync(paths(key).pages, 'not a directory');
    expect(runDoctor(loadConfig(), '>=22', cwd).find((f) => f.check === 'scope')?.level).toBe(
      'error'
    );
  });

  it('returns unknown inbox age when stat throws after the existence check', () => {
    seedStore(KEY, { inboxEntries: 1 });
    vi.spyOn(fs, 'stat').mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(inboxAgeMs(paths(KEY).inbox)).toBeUndefined();
  });
});
