/** The host argument survives the built bundle (issue #18): asserted through the same
 * spawn-and-inspect seam as the other hook suites, not by importing the TS source. */

import { describe, it, expect } from 'vitest';
import { createTempDir } from './helpers.js';
import { keyFor, runHook, seedStore, statsLines } from './hook-fixture.js';

describe('hook host argument', () => {
  it('records the declared host on the stats line', () => {
    const cwd = createTempDir('mehmory-project');
    seedStore(keyFor(cwd));

    const run = runHook(
      'user-prompt-submit',
      { session_id: 'host-declared', prompt: 'hello' },
      { cwd, args: ['claude-code'] }
    );

    expect(run.status).toBe(0);
    expect(statsLines().at(-1)).toMatchObject({ hook: 'UserPromptSubmit', host: 'claude-code' });
  });

  it('resolves sensibly and never fails the hook when no host argument is passed (A2)', () => {
    const cwd = createTempDir('mehmory-project');
    seedStore(keyFor(cwd));

    const run = runHook('user-prompt-submit', { session_id: 'host-absent', prompt: 'hello' }, { cwd });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(statsLines().at(-1)).toMatchObject({ hook: 'UserPromptSubmit', host: 'claude-code' });
  });

  it('falls back rather than failing on an unrecognized host argument (issue #20)', () => {
    const cwd = createTempDir('mehmory-project');
    seedStore(keyFor(cwd));

    const run = runHook(
      'user-prompt-submit',
      { session_id: 'host-other', prompt: 'hello' },
      { cwd, args: ['some-future-harness'] }
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(statsLines().at(-1)).toMatchObject({
      hook: 'UserPromptSubmit',
      host: 'claude-code',
    });
  });
});
