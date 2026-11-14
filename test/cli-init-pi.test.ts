/** `mehmory init --host pi` — the store, then the Pi install named, nothing written into Pi. */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from './helpers.js';
import { envelopeOf, runCli } from './cli-fixture.js';

describe('mehmory init --host pi', () => {
  it('creates the store and names `pi install` as the next step', () => {
    const run = runCli(['init', '--host', 'pi', '--json']);

    expect(run.status).toBe(0);
    const home = process.env.MEHMORY_HOME ?? '';
    expect(envelopeOf(run)['data']).toEqual({
      host: 'pi',
      home,
      node: { current: process.version, required: '>=22', ok: true },
      next: ['pi install git:github.com/elderfo/mehmory'],
    });
    expect(existsSync(join(home, 'SCHEMA.md'))).toBe(true);
  });

  it('says where the install command is typed', () => {
    const run = runCli(['init', '--host', 'pi']);

    expect(run.stdout.split('\n').at(-2)).toBe(
      'next: in a shell, run `pi install git:github.com/elderfo/mehmory`'
    );
  });

  it('writes nothing under ~/.pi: Pi’s package manager owns the install', () => {
    const home = createTempDir('mehmory-pi-home');

    expect(runCli(['init', '--host', 'pi'], { claudeHome: home }).status).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  });

  it('rejects --uninstall with the `pi remove` command as the fix', () => {
    const run = runCli(['init', '--host', 'pi', '--uninstall', '--json']);

    expect(run.status).toBe(1);
    expect(envelopeOf(run)['errors']).toMatchObject([
      { code: 'E_USAGE', fix: 'pi remove git:github.com/elderfo/mehmory' },
    ]);
  });
});
