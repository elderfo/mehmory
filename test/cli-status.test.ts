/** `mehmory status` — criterion 9. */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { envelopeOf, runCli } from './cli-fixture.js';
import { recordWarning } from '../src/core/errors.js';

function home(): string {
  return process.env.MEHMORY_HOME ?? '';
}

/** A store with one populated project scope, and the cwd that resolves to it. */
function populated(): string {
  const cwd = createTempDir('mehmory-cli-cwd');
  expect(runCli(['init'], { cwd }).status).toBe(0);

  const key = envelopeKey(cwd);
  const dir = join(home(), 'projects', key);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(join(dir, 'pages', 'deploy-process.md'), '# deploy\n');
  writeFileSync(join(dir, 'pages', 'vpn.md'), '# vpn\n');
  writeFileSync(
    join(dir, 'index.md'),
    '# Index\n\n- [[deploy-process]] — staging via Actions\n- [[vpn]] — needs the VPN\nnot an index line\n'
  );
  writeFileSync(
    join(dir, 'inbox.md'),
    '# Inbox\n\n' +
      '- older <!--mehmory id=0000000000000001 src=s ts=2026-07-01T00:00:00.000Z-->\n' +
      '- newer <!--mehmory id=0000000000000002 src=s ts=2026-07-05T00:00:00.000Z-->\n'
  );
  writeFileSync(
    join(dir, 'log.md'),
    '# Log\n\n## 2026-07-02T00:00:00.000Z integrate | 3 entries\n## 2026-07-04T00:00:00.000Z lint | swept\n'
  );
  return cwd;
}

/** The project key the CLI resolves for a cwd, taken from its own `--json` output. */
function envelopeKey(cwd: string): string {
  const data = envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>;
  return String(data['key']);
}

describe('mehmory status', () => {
  it('prints one screen of the resolved scope', () => {
    const cwd = populated();
    const run = runCli(['status'], { cwd });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('pages    2');
    expect(run.stdout).toContain('index    2 lines');
    expect(run.stdout).toContain('inbox    2 entries, oldest 2026-07-01T00:00:00.000Z');
    expect(run.stdout).toContain('integrate 2026-07-02T00:00:00.000Z');
    expect(run.stdout).toMatch(/scope {4}project \S+/);
  });

  it('counts only real index lines, not every line in index.md', () => {
    const cwd = populated();
    const data = envelopeOf(runCli(['status', '--json'], { cwd }))['data'] as Record<string, unknown>;
    expect(data['indexLines']).toBe(2);
    expect(data['pages']).toBe(2);
  });

  it('reports the store’s last commit', () => {
    const cwd = populated();
    execFileSync('git', ['-C', home(), 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', home(), 'commit', '--no-gpg-sign', '-m', 'seeded'], { stdio: 'pipe' });
    expect(runCli(['status'], { cwd }).stdout).toContain('seeded');
  });

  it('leaves a pending warning pending — twice', () => {
    // `pendingWarnings()` returns *and clears*, and is SessionStart's only channel. A
    // `status` that used it would be the last place the user ever saw the warning.
    const cwd = populated();
    recordWarning('E_GIT_COMMIT');
    const before = readFileSync(join(home(), '.state', 'warnings.json'), 'utf-8');

    for (let run = 0; run < 2; run++) {
      const result = runCli(['status', '--json'], { cwd });
      const envelope = envelopeOf(result);
      expect(envelope['warnings']).toHaveLength(1);
      expect(String((envelope['warnings'] as string[])[0])).toContain('E_GIT_COMMIT');
    }

    expect(readFileSync(join(home(), '.state', 'warnings.json'), 'utf-8')).toBe(before);
  });

  it('exits 2 with a runnable fix when there is no store', () => {
    const run = runCli(['status']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Fix: mehmory init');
  });
});
