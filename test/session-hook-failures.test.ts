import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { statePath } from '../src/core/home.js';
import { runHook } from '../src/core/hook.js';
import * as fsModule from '../src/core/fs.js';
import { rememberTopic, setPaused } from '../src/core/session.js';
import { openSession } from '../src/core/session-lifecycle.js';
import { readInboxEntries } from '../src/core/inbox.js';
import { errorsLog, paths, seedStore, writeTranscript } from './hook-fixture.js';
import { markerFileFor } from './session-fixture.js';
import '../src/hooks/user-prompt-submit.js';
import '../src/hooks/session-start.js';
import '../src/hooks/session-end.js';

vi.mock('../src/core/hook.js', () => ({ runHook: vi.fn() }));

// Exercise the real adapter bodies separately from the runner's locked origin recording.
const bodies = new Map(vi.mocked(runHook).mock.calls.map(([event, body]) => [event, body]));
const project = 'session-hook-failures';

function body(event: string) {
  const result = bodies.get(event);
  if (!result) throw new Error(`no adapter registered for ${event}`);
  return result;
}

function holdSessionLock(id: string) {
  fsModule.mkdir(statePath('locks'));
  writeFileSync(statePath('locks', `sessions_${id}.lock`), String(process.pid));
}

afterEach(() => vi.restoreAllMocks());

describe('session hook failure paths', () => {
  it('paused remember returns without capture or a 200 ms lock wait', () => {
    seedStore(project);
    setPaused('paused', true);
    holdSessionLock('paused');
    const config = loadConfig();
    const started = performance.now();
    const result = body('UserPromptSubmit')(
      { session_id: 'paused', prompt: 'remember: keep this private while paused' },
      project,
      'claude-code',
      config
    );
    const elapsed = performance.now() - started;

    expect(result).toEqual({});
    expect(readInboxEntries(paths(project).inbox)).toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });

  it('SessionStart preserves its pause gate under session lock contention', () => {
    seedStore(project);
    setPaused('paused', true);
    holdSessionLock('paused');

    expect(
      body('SessionStart')({ session_id: 'paused' }, project, 'claude-code', loadConfig())
    ).toEqual({});
  });

  it('UserPromptSubmit preserves its topic cache under session lock contention', () => {
    seedStore(project);
    rememberTopic('cached', new Set(['deployment']));
    holdSessionLock('cached');

    expect(
      body('UserPromptSubmit')(
        { session_id: 'cached', prompt: 'deployment' },
        project,
        'claude-code',
        loadConfig()
      )
    ).toEqual({ stats: { pointers_offered: 0, topic_cache_hit: true } });
  });

  it('SessionEnd stats report a failed marker, not deferred capture that cannot be swept', () => {
    seedStore(project);
    const transcript = writeTranscript([
      { text: 'We decided to retain completed capture counts.' },
    ]);
    openSession('ended', { transcriptPath: transcript, project, host: 'claude-code' });
    const write = fsModule.atomicWrite;
    vi.spyOn(fsModule, 'atomicWrite').mockImplementation((path, content) => {
      if (path === markerFileFor('ended')) throw new Error('marker write failed');
      write(path, content);
    });

    expect(
      body('SessionEnd')(
        { session_id: 'ended', transcript_path: transcript },
        project,
        'claude-code',
        loadConfig()
      ).stats
    ).toMatchObject({ captured_entries: 1, deferred: false, marker_failed: true });
    expect(errorsLog()).toContain('E_APPEND_FAILED: SessionEnd hook failed: marker write failed');
  });
});
