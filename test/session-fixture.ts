import { createHash } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { statePath } from '../src/core/home.js';
import { inspectSession, observeSession } from '../src/core/session-lifecycle.js';
import type { SessionState } from '../src/core/session.js';

/** Raw paths are only for disk assertions and corrupt/legacy/failure fixtures. */
export function stateFileFor(id: string): string {
  return statePath(`${createHash('sha256').update(id).digest('hex')}.json`);
}

export function markerFileFor(id: string): string {
  return stateFileFor(id).replace(/\.json$/, '.finalized.json');
}

/** Generation is asserted for legacy-format continuity, never supplied to a transition. */
export function sessionState(id: string): SessionState & { readonly generation?: number } {
  return inspectSession(id).state;
}

export function seedSession(state: SessionState): void {
  observeSession(state.session_id, (current) => Object.assign(current, state));
}

export function ageSession(id: string, transcript?: string): void {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(stateFileFor(id), old, old);
  if (transcript && existsSync(transcript)) utimesSync(transcript, old, old);
}

export function changeSession(id: string, mutate: (state: SessionState) => SessionState): void {
  observeSession(id, (state) => Object.assign(state, mutate(state)));
}
