import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import {
  buildScopeInjection,
  inboxBytes,
  storeIsUnpopulated,
  staleSessionStartWarning,
} from '../src/core/capture.js';
import { peekWarnings, recordWarning } from '../src/core/errors.js';
import { mehmoryHome, statePath } from '../src/core/home.js';
import { runDoctor } from '../src/core/doctor.js';
import { buildStatus, countPages, inboxAgeMs } from '../src/core/status.js';
import { searchScope } from '../src/core/search.js';
import { tokenize } from '../src/core/match.js';
import { estimateTokens } from '../src/core/tokens.js';
import * as fs from '../src/core/fs.js';
import { additionalContext, errorsLog, keyFor, paths, runHook, seedStore } from './hook-fixture.js';
import { createTempDir } from './helpers.js';

const KEY = 'maintenance-regressions';

afterEach(() => {
  vi.restoreAllMocks();
});

function oversizedStore(key: string): void {
  seedStore(key, { project: 'p'.repeat(40000), index: 'i'.repeat(40000), inboxEntries: 30 });
  writeFileSync(join(mehmoryHome(), 'global', 'identity.md'), 'u'.repeat(40000));
}

describe('maintenance and reduced-frame regressions', () => {
  it('keeps warning and compact notices beside a saturated frame, within budget plus 150', () => {
    const cwd = createTempDir('maintenance-cwd');
    const key = keyFor(cwd);
    oversizedStore(key);
    recordWarning('E_CONFIG_PARSE');
    const context = additionalContext(
      runHook('session-start', { session_id: 'saturated', source: 'compact' }, { cwd })
    );
    const lines = context.split('\n').filter((line) => line.startsWith('mehmory: '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('E_CONFIG_PARSE');
    expect(lines[1]).toContain('context was compacted');
    expect(context).not.toContain('inbox has');
    expect(estimateTokens(context)).toBeLessThanOrEqual(950);
    expect(estimateTokens(context.split('\nmehmory: ')[0] ?? '')).toBeLessThanOrEqual(800);
  });

  it('keeps an integrate nudge beside a saturated frame', () => {
    const cwd = createTempDir('nudge-cwd');
    const key = keyFor(cwd);
    oversizedStore(key);
    const context = additionalContext(runHook('session-start', { session_id: 'nudge' }, { cwd }));
    expect(context).toContain('mehmory: inbox has 30 entries — run /mehmory:integrate');
    expect(estimateTokens(context)).toBeLessThanOrEqual(950);
  });

  it.each(['published', 'legacy'])(
    'delivers an unselected %s warning on the second run',
    (storage) => {
      const cwd = createTempDir('warning-cwd');
      const key = keyFor(cwd);
      oversizedStore(key);
      if (storage === 'legacy') {
        writeFileSync(
          statePath('warnings.json'),
          JSON.stringify([
            { code: 'E_CONFIG_PARSE', lastTime: Date.now(), count: 1 },
            { code: 'E_GIT_COMMIT', lastTime: Date.now(), count: 1 },
          ])
        );
      } else {
        recordWarning('E_CONFIG_PARSE');
        recordWarning('E_GIT_COMMIT');
      }
      const first = additionalContext(
        runHook('session-start', { session_id: 'first', source: 'compact' }, { cwd })
      );
      expect(first).not.toContain('E_GIT_COMMIT');
      expect(peekWarnings().some((warning) => warning.startsWith('E_GIT_COMMIT'))).toBe(true);
      const second = additionalContext(
        runHook('session-start', { session_id: 'second', source: 'compact' }, { cwd })
      );
      expect(second).toContain('E_GIT_COMMIT');
      expect(peekWarnings()).toEqual([]);
    }
  );

  it('leaves warnings not emitted by the stale-start fallback pending', () => {
    seedStore(KEY);
    recordWarning('E_CONFIG_PARSE');
    recordWarning('E_GIT_COMMIT');
    expect(staleSessionStartWarning(KEY)).toContain('E_CONFIG_PARSE');
    expect(peekWarnings()).toEqual([
      `E_GIT_COMMIT (informational, 1 occurrences): see ${statePath('errors.log')}`,
    ]);
  });

  it('truncates a long claimed warning rather than discarding it', () => {
    const cwd = createTempDir('long-warning-cwd');
    const key = keyFor(cwd);
    oversizedStore(key);
    writeFileSync(
      statePath('warnings.json'),
      JSON.stringify([
        { code: `E_CONFIG_PARSE_${'x'.repeat(1000)}`, lastTime: Date.now(), count: 1 },
      ])
    );
    const context = additionalContext(
      runHook('session-start', { session_id: 'long-warning', source: 'compact' }, { cwd })
    );
    expect(context).toContain('mehmory: E_CONFIG_PARSE_');
    expect(context).toContain('context was compacted');
    expect(estimateTokens(context)).toBeLessThanOrEqual(950);
    expect(peekWarnings()).toEqual([]);
  });

  it.each([20, 40, 80, 120, 125])(
    'preserves session identity while degrading a %i-token frame',
    (budget) => {
      oversizedStore(KEY);
      const config = { ...loadConfig(), injection: { budget_tokens: budget } };
      const frame = buildScopeInjection(KEY, config, 's1');
      expect(frame.text).toContain('\nsession: s1\n');
      expect(frame.text).not.toContain('<mehmory-routing>');
      expect(frame.tokens).toBeLessThanOrEqual(budget);
    }
  );

  it('keeps the routing block on an oversized store at the default budget', () => {
    oversizedStore(KEY);
    const config = loadConfig();
    expect(config.injection.budget_tokens).toBe(800);
    const frame = buildScopeInjection(KEY, config, 's1');
    expect(frame.text).toContain('<mehmory-routing>');
    expect(frame.text).toContain('\nsession: s1\n');
    expect(frame.tokens).toBeLessThanOrEqual(800);
  });

  it('never redacts a whole oversized part to decide routing', () => {
    seedStore(KEY);
    writeFileSync(join(mehmoryHome(), 'global', 'identity.md'), 'u '.repeat(170_000));
    const frame = buildScopeInjection(KEY, loadConfig(), 's1');
    expect(frame.text).toContain('<mehmory-routing>');
    expect(frame.text).toContain('u u u');
    expect(peekWarnings().some((warning) => warning.startsWith('E_REDACT_FAILED'))).toBe(false);
    expect(errorsLog()).not.toContain('E_REDACT_FAILED');
  });

  it('counts maintenance allowance in the configured doctor KPI', () => {
    seedStore(KEY);
    const config = { ...loadConfig(), injection: { budget_tokens: 400 } };
    const writeStats = (tokens: number): void => {
      writeFileSync(
        statePath('stats.jsonl'),
        JSON.stringify({
          ts: new Date().toISOString(),
          project: KEY,
          hook: 'SessionStart',
          ms: 5,
          injected_tokens: tokens,
        }) + '\n'
      );
    };
    writeStats(550);
    expect(
      runDoctor(config, '>=22').find((finding) => finding.check === 'kpi.injection')
    ).toBeUndefined();
    writeStats(551);
    expect(
      runDoctor(config, '>=22').find((finding) => finding.check === 'kpi.injection')?.message
    ).toBe('injected tokens p95 is 551, over the 550 combined budget');
  });
});

describe('read probe and scope regressions', () => {
  it('reports a direct scope repair and continues inbox and integrate checks when pages is a file', () => {
    const cwd = createTempDir('scope-cwd');
    const key = keyFor(cwd);
    seedStore(key, { inboxEntries: 30 });
    rmSync(paths(key).pages, { recursive: true });
    writeFileSync(paths(key).pages, 'not a directory');
    const findings = runDoctor(loadConfig(), '>=22', cwd);
    expect(findings.find((finding) => finding.check === 'scope')).toMatchObject({
      level: 'error',
      fix: `mv -n '${paths(key).pages}' '${paths(key).pages}.bak' && mkdir '${paths(key).pages}'`,
    });
    expect(findings.find((finding) => finding.check === 'inbox')?.level).toBe('warn');
    expect(findings.find((finding) => finding.check === 'integrate')?.level).toBe('ok');
  });

  it('logs an informational read code for page listing and status reads', () => {
    seedStore(KEY);
    rmSync(paths(KEY).pages, { recursive: true });
    writeFileSync(paths(KEY).pages, 'not a directory');
    expect(countPages(paths(KEY).pages)).toBe(0);
    mkdirSync(paths(KEY).inbox);
    rmSync(paths(KEY).index);
    mkdirSync(paths(KEY).index);
    buildStatus(KEY, paths(KEY).projectDir);
    vi.spyOn(fs, 'stat').mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(inboxAgeMs(paths(KEY).inbox)).toBeUndefined();
    expect(errorsLog()).toContain('E_STORE_READ');
    expect(errorsLog()).not.toContain('E_APPEND_FAILED');
    expect(
      peekWarnings().every((warning) => warning.startsWith('E_STORE_READ (informational,'))
    ).toBe(true);
  });

  it('keeps SessionStart injection when pages is a file in an otherwise empty scope', () => {
    const cwd = createTempDir('unpopulated-cwd');
    const key = keyFor(cwd);
    seedStore(key, { project: '', index: '' });
    rmSync(paths(key).pages, { recursive: true });
    writeFileSync(paths(key).pages, 'not a directory');
    const context = additionalContext(runHook('session-start', { session_id: 's1' }, { cwd }));
    expect(context).toContain('\nsession: s1\n');
    expect(context).toContain('# identity');
    expect(storeIsUnpopulated(key)).toBe(true);
  });

  it('returns zero inbox bytes when stat fails after existence check', () => {
    seedStore(KEY, { inboxEntries: 1 });
    vi.spyOn(fs, 'stat').mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(inboxBytes(paths(KEY).inbox)).toBe(0);
    expect(errorsLog()).toContain('E_STORE_READ');
  });
});

describe('retrieval fixture and snippet regressions', () => {
  it('isolates evergreen vocabulary from every unrelated golden query', () => {
    const golden = JSON.parse(
      readFileSync(resolve('test/fixtures/golden-queries.json'), 'utf-8')
    ) as {
      pages: Record<string, string>;
      queries: { id: string; query: string }[];
    };
    const evergreen = Object.entries(golden.pages).find(([, body]) =>
      body.includes('decay: evergreen')
    );
    expect(evergreen).toBeDefined();
    const body = `${evergreen?.[0] ?? ''} ${evergreen?.[1] ?? ''}`.toLowerCase();
    for (const query of golden.queries.filter((query) => !query.id.startsWith('evergreen-'))) {
      for (const token of tokenize(query.query)) expect(body, query.id).not.toContain(token);
    }
  });

  it('does not split a surrogate pair at the search snippet boundary', () => {
    seedStore(KEY, { pages: { 'emoji.md': `deploy ${'x'.repeat(111)}😀tail` } });
    const hits = searchScope('deploy', KEY, {
      pagesDir: paths(KEY).pages,
      archiveDir: join(paths(KEY).projectDir, 'archive'),
      logFile: paths(KEY).log,
    }).hits;
    expect(hits[0]?.snippet).toBe(`deploy ${'x'.repeat(111)}…`);
  });
});
