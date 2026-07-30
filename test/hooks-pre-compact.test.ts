/** PreCompact fixture tests (criteria 12, 14, 16). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTempDir } from './helpers.js';
import {
  keyFor,
  paths,
  readIfPresent,
  runHook,
  seedStore,
  statsLines,
  writeTranscript,
} from './hook-fixture.js';
import { readSessionState, updateSessionState } from '../src/core/session.js';

describe('PreCompact hook', () => {
  let cwd: string;
  let key: string;
  let transcript: string;

  beforeEach(() => {
    cwd = createTempDir('mehmory-project');
    key = keyFor(cwd);
    seedStore(key);
    transcript = writeTranscript([
      { text: 'We decided to keep the queue durable.' },
      { text: 'The token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is in CI.' },
    ]);
  });

  it('distills into the inbox and emits no decision', () => {
    updateSessionState('s1', state => ({ ...state, stop_count: 7 }));

    const run = runHook('pre-compact', { session_id: 's1', transcript_path: transcript }, { cwd });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');

    const inbox = readIfPresent(paths(key).inbox);
    expect(inbox).toContain('durable');
    expect(inbox).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(readSessionState('s1').stop_count).toBe(0);
    expect(statsLines().at(-1)).toMatchObject({ hook: 'PreCompact' });
  });

  it('does not re-append the same delta on a second pass', () => {
    runHook('pre-compact', { session_id: 's1', transcript_path: transcript }, { cwd });
    const first = readIfPresent(paths(key).inbox);

    runHook('pre-compact', { session_id: 's1', transcript_path: transcript }, { cwd });

    expect(readIfPresent(paths(key).inbox)).toBe(first);
  });
});
