/**
 * Session transitions, origin and retirement (A13), using one locked snapshot.
 * Legacy `.state/<sha256(session-id)>.json` and `.finalized.json` formats stay readable.
 */
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { statePath, mehmoryHome } from './home.js';
import { atomicWrite, listDir, pathExists, readFile, remove, stat } from './fs.js';
import { failOpen, logError, type ErrorCode } from './errors.js';
import { advanceCursor, freshCursor, isCursorState, type CursorState } from './cursor.js';
import { withSessionLock } from './lock.js';
import { isContainedProjectKey } from './identity.js';
import { INBOX_HOSTS, type InboxHost } from '../schema/format.js';
import { isSafeAgentName } from './agent.js';
import type { MehmoryConfig } from './config.js';
import { freshSessionState, type SessionState, type TopicCache } from './session-state.js';
import { appendLogEntry, distillJobPayload, distillSessionDelta } from './capture.js';
import { scopePaths } from './wiki.js';
import { commitPaths } from './git.js';
import { enqueueJob } from './queue.js';

export interface SessionOrigin {
  readonly transcriptPath?: string;
  readonly host: InboxHost;
  readonly project: string;
  readonly agent?: string;
}

interface StoredSessionState extends SessionState {
  generation?: number;
}

interface Position {
  state: StoredSessionState;
  exists: boolean;
  readonly original: string;
  readonly stateRaw?: string;
  marker?: string;
  readonly markerState?: StoredSessionState;
  readonly markerCursor?: CursorState;
  readonly markerTime?: number;
  resumed: boolean;
}

function stateFile(sessionId: string): string {
  return statePath(`${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

function markerFile(sessionId: string): string {
  return stateFile(sessionId).replace(/\.json$/, '.finalized.json');
}

function parseState(raw: string, sessionId: string): StoredSessionState | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (v['session_id'] !== sessionId || !isCursorState(v['cursor'])) return null;
  if (typeof v['stop_count'] !== 'number') return null;
  const topic = v['topic'];
  let topicCache: TopicCache | undefined;
  if (typeof topic === 'object' && topic !== null) {
    const t = topic as Record<string, unknown>;
    if (Array.isArray(t['tokens']) && typeof t['ts'] === 'number') {
      topicCache = { tokens: t['tokens'].filter((x) => typeof x === 'string'), ts: t['ts'] };
    }
  }
  const rawHost = v['host'];
  const host =
    typeof rawHost === 'string' && (INBOX_HOSTS as readonly string[]).includes(rawHost)
      ? (rawHost as InboxHost)
      : undefined;
  return {
    session_id: sessionId,
    cursor: v['cursor'],
    stop_count: v['stop_count'],
    ...(topicCache ? { topic: topicCache } : {}),
    ...(typeof v['generation'] === 'number' && Number.isInteger(v['generation'])
      ? { generation: v['generation'] }
      : {}),
    ...(typeof v['project_key'] === 'string' && isContainedProjectKey(v['project_key'])
      ? { project_key: v['project_key'] }
      : {}),
    ...(typeof v['transcript_path'] === 'string' ? { transcript_path: v['transcript_path'] } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(v['agent'] === null || (typeof v['agent'] === 'string' && isSafeAgentName(v['agent']))
      ? { agent: v['agent'] }
      : {}),
    paused: v['paused'] === true,
  };
}

function loadPosition(sessionId: string, reportMalformed = true): Position {
  const exists = pathExists(stateFile(sessionId));
  let state: StoredSessionState = freshSessionState(sessionId);
  let stateRaw: string | undefined;
  if (exists) {
    let parsed: StoredSessionState | null = null;
    try {
      stateRaw = readFile(stateFile(sessionId));
      parsed = parseState(stateRaw, sessionId);
    } catch {
      /* reset below */
    }
    if (parsed) state = parsed;
    else if (reportMalformed)
      logError({
        code: 'E_SESSION_STATE',
        kind: 'informational',
        what: `session state for ${sessionId} was unreadable or malformed`,
        consequence: 'Capture state reset to fresh; the transcript may be re-distilled once',
      });
  }
  const position: Position = {
    state,
    exists,
    stateRaw,
    original: JSON.stringify(state),
    resumed: false,
  };
  if (!pathExists(markerFile(sessionId))) return position;
  let marker = '';
  let markerState: StoredSessionState = freshSessionState(sessionId);
  let markerCursor: CursorState | undefined;
  try {
    marker = readFile(markerFile(sessionId));
    const raw: unknown = JSON.parse(marker);
    if (typeof raw === 'object' && raw !== null) {
      const cursor = (raw as Record<string, unknown>)['cursor'];
      if (isCursorState(cursor)) markerCursor = cursor;
      markerState =
        parseState(
          JSON.stringify({
            ...raw,
            session_id: sessionId,
            cursor: markerCursor ?? freshCursor(),
            stop_count: 0,
          }),
          sessionId
        ) ?? markerState;
    }
  } catch {
    /* An explicit open can recover even an unreadable marker. */
  }
  return {
    ...position,
    marker,
    markerState,
    markerCursor,
    markerTime: Number(stat(markerFile(sessionId))?.mtimeMs ?? Infinity),
  };
}

function activate(position: Position, explicit: boolean, transcriptPath?: string): boolean {
  if (position.marker === undefined) return true;
  if (!explicit) {
    const transcript = transcriptPath ?? position.markerState?.transcript_path;
    if (!transcript || !pathExists(transcript)) return false;
    const info = stat(transcript);
    if (info?.isFile() !== true) return false;
    const cursor = position.markerCursor;
    // Pre-existing incomplete tails, mtime-only changes and truncation are not new work.
    const grew =
      cursor && cursor.file_id !== ''
        ? info.size > Math.max(cursor.offset, cursor.size)
        : info.mtimeMs > (position.markerTime ?? Infinity);
    if (!grew) return false;
  }
  const saved: StoredSessionState =
    position.markerState ?? freshSessionState(position.state.session_id);
  const current = position.exists
    ? position.state
    : { ...saved, paused: !explicit && saved.paused };
  position.state = {
    ...current,
    generation: Math.max(saved.generation ?? 0, position.state.generation ?? 0) + 1,
  };
  position.resumed = true;
  return true;
}

function persist(position: Position, observed = false): void {
  const state = position.state;
  const content = JSON.stringify(state);
  if (!position.resumed) {
    if (observed || content !== position.original)
      atomicWrite(stateFile(state.session_id), content);
    return;
  }
  let removed = false;
  try {
    remove(markerFile(state.session_id));
    removed = true;
    atomicWrite(stateFile(state.session_id), content);
  } catch (err) {
    if (removed) {
      try {
        atomicWrite(markerFile(state.session_id), position.marker ?? '');
      } catch {
        /* next open retries */
      }
    }
    throw err;
  }
}

/** Lock-free snapshot; inbox-tx may explicitly probe availability before a mutation. */
export function inspectSession(
  sessionId: string,
  options: { requireAvailable?: boolean } = {}
): {
  state: SessionState;
  exists: boolean;
  finalized: boolean;
  available: boolean;
} {
  const unavailable = {
    state: freshSessionState(sessionId),
    exists: false,
    finalized: false,
    available: false,
  };
  const snapshot = () => {
    const position = loadPosition(sessionId);
    return {
      state: position.state,
      exists: position.exists,
      finalized: position.marker !== undefined,
      available: true,
    };
  };
  return failOpen(
    () =>
      options.requireAvailable ? (withSessionLock(sessionId, snapshot) ?? unavailable) : snapshot(),
    unavailable,
    'E_SESSION_STATE'
  );
}

export type SessionObservation<T> =
  { status: 'observed'; value: T } | { status: 'retired' } | { status: 'skipped' };

/** Observe active state once. Value mutations refresh liveness; delta previews may skip the touch. */
export function observeSession<T>(
  sessionId: string,
  observe: (state: SessionState) => T,
  options: {
    transcriptPath?: string;
    touch?: boolean;
    /** Callback failures belong to the operation, not to session-state parsing. */
    callbackErrorCode?: ErrorCode;
  } = {}
): SessionObservation<T> {
  return failOpen<SessionObservation<T>>(
    () =>
      withSessionLock<SessionObservation<T>>(sessionId, () => {
        const position = loadPosition(sessionId);
        if (!activate(position, false, options.transcriptPath)) return { status: 'retired' };
        const result = failOpen<SessionObservation<T>>(
          () => ({ status: 'observed', value: observe(position.state) }),
          { status: 'skipped' },
          options.callbackErrorCode ?? 'E_SESSION_STATE'
        );
        if (result.status === 'observed') persist(position, options.touch !== false);
        return result;
      }) ?? { status: 'skipped' },
    { status: 'skipped' },
    'E_SESSION_STATE'
  );
}

/** Open or observe an origin. SessionStart resumes before recording origin or reading pause. */
export function openSession(
  sessionId: string,
  origin?: SessionOrigin,
  event = 'SessionStart',
  config?: MehmoryConfig
): boolean {
  if (event === 'SessionStart' && config?.hooks.session_start.enabled === false) return false;
  return failOpen(
    () =>
      withSessionLock(sessionId, () => {
        const position = loadPosition(sessionId);
        if (!activate(position, event === 'SessionStart', origin?.transcriptPath)) return false;
        if (origin?.transcriptPath) {
          Object.assign(position.state, {
            transcript_path: origin.transcriptPath,
            host: origin.host,
            project_key: origin.project,
            agent: origin.agent ?? null,
          });
        }
        persist(position);
        return position.resumed;
      }) ?? false,
    false,
    'E_SESSION_STATE'
  );
}

export interface FinalizeSessionResult {
  readonly capturedEntries: number;
  readonly deferred?: boolean;
  /** Final-delta handling completed, but retirement could not be recorded. */
  readonly markerFailed?: boolean;
}
export interface FinalizeSessionOptions {
  /** ACP writes its transcript after SessionEnd; the idle recovery path force-retires it. */
  readonly deferWhenTranscriptAbsent?: boolean;
}

function sessionEndLogTag(sessionId: string, generation: number): string {
  return generation === 0
    ? `(session ${sessionId})`
    : `(session ${JSON.stringify({ id: sessionId, generation })})`;
}

function retire(position: Position, state: StoredSessionState, cursor?: CursorState): boolean {
  const sessionId = state.session_id;
  try {
    if (position.exists) remove(stateFile(sessionId));
    position.exists = false;
  } catch {
    /* swept later */
  }
  const marker = JSON.stringify({
    session_id: sessionId,
    generation: state.generation ?? 0,
    ...(cursor ? { cursor } : {}),
    transcript_path: state.transcript_path,
    host: state.host,
    project_key: state.project_key,
    agent: state.agent,
    paused: state.paused,
  });
  try {
    atomicWrite(markerFile(sessionId), marker);
    position.marker = marker;
    return true;
  } catch (err) {
    logError({
      code: 'E_APPEND_FAILED',
      kind: 'informational',
      what: `SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`,
      consequence: 'Final-delta handling completed, but the retirement marker was not saved',
    });
    return false;
  }
}

function finalize(
  position: Position,
  transcriptPath: string | undefined,
  project: string,
  host: InboxHost,
  config: MehmoryConfig,
  options: FinalizeSessionOptions
): FinalizeSessionResult {
  const sessionId = position.state.session_id;
  if (!activate(position, false, transcriptPath)) return { capturedEntries: 0 };
  const state = position.state;
  const generation = state.generation ?? 0;
  const origin = {
    ...state,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    project_key: project,
    host,
  };
  if (state.paused) {
    const marked = retire(position, origin);
    return { capturedEntries: 0, ...(marked ? {} : { markerFailed: true }) };
  }
  if (
    options.deferWhenTranscriptAbsent &&
    transcriptPath &&
    !pathExists(transcriptPath) &&
    state.transcript_path !== undefined
  ) {
    persist(position);
    return { capturedEntries: 0, deferred: true };
  }
  const paths = scopePaths(project);
  const alreadyLogged =
    pathExists(paths.logFile) &&
    readFile(paths.logFile).includes(sessionEndLogTag(sessionId, generation));
  let capturedEntries = 0;
  if (!alreadyLogged) {
    const delta = distillSessionDelta(
      sessionId,
      transcriptPath,
      host,
      config,
      state.agent ?? undefined,
      state.cursor
    );
    const { entries } = delta;
    if (
      entries.length > 0 &&
      enqueueJob(distillJobPayload(project, entries), 'distill-final') === null
    ) {
      persist(position);
      return { capturedEntries: 0, deferred: true };
    }
    if (transcriptPath && delta.endOffset !== undefined) {
      state.cursor = advanceCursor(
        state.cursor,
        transcriptPath,
        delta.recordHash ?? '',
        delta.endOffset
      );
    }
    appendLogEntry(
      project,
      'session-end',
      `${String(entries.length)} entries queued for integration ${sessionEndLogTag(sessionId, generation)}`
    );
    const home = mehmoryHome();
    const touched = [paths.logFile, paths.inboxFile]
      .filter(pathExists)
      .map((path) => relative(home, path));
    if (touched.length > 0 && pathExists(join(home, '.git')))
      commitPaths(touched, `mehmory: session ${sessionId} ended`, home);
    capturedEntries = entries.length;
  }
  const marked = retire(position, origin, state.cursor);
  return { capturedEntries, ...(marked ? {} : { markerFailed: true }) };
}

/** Enqueue the final delta, log and commit once per generation, then retire the session. */
export function finalizeSession(
  sessionId: string,
  transcriptPath: string | undefined,
  project: string,
  host: InboxHost,
  config: MehmoryConfig,
  options: FinalizeSessionOptions = {}
): FinalizeSessionResult {
  return failOpen(
    () =>
      withSessionLock(sessionId, () =>
        finalize(loadPosition(sessionId), transcriptPath, project, host, config, options)
      ) ?? { capturedEntries: 0 },
    { capturedEntries: 0, deferred: true },
    'E_APPEND_FAILED'
  );
}

const PENDING_IDLE_MS = 30 * 60 * 1000;

function sessionFiles(): { path: string; id: string; marker: boolean }[] {
  if (!pathExists(statePath())) return [];
  const files: { path: string; id: string; marker: boolean }[] = [];
  for (const name of listDir(statePath())) {
    if (!name.endsWith('.json')) continue;
    const path = join(statePath(), name);
    try {
      const raw: unknown = JSON.parse(readFile(path));
      if (typeof raw !== 'object' || raw === null) continue;
      const id = (raw as Record<string, unknown>)['session_id'];
      if (typeof id === 'string')
        files.push({ path, id, marker: name.endsWith('.finalized.json') });
    } catch {
      /* Not a session or vanished during enumeration. */
    }
  }
  return files;
}

function pending(position: Position, path: string, cutoff: number): boolean {
  if (
    !position.exists ||
    position.marker !== undefined ||
    position.state.transcript_path === undefined
  )
    return false;
  const mtime = stat(path)?.mtimeMs;
  if (mtime === undefined || mtime > cutoff) return false;
  const transcript = position.state.transcript_path;
  if (pathExists(transcript)) {
    const mtime = stat(transcript)?.mtimeMs;
    if (mtime !== undefined && mtime > cutoff) return false;
  }
  return true;
}

function sweepable(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['session_id'] === 'string'
    );
  } catch {
    return false;
  }
}

function sweep(position: Position, files: ReturnType<typeof sessionFiles>, cutoff: number): number {
  let swept = 0;
  const id = position.state.session_id;
  for (const file of files) {
    const deleted = failOpen(
      () => {
        if (!pathExists(file.path)) return false;
        const mtime = stat(file.path)?.mtimeMs;
        if (mtime === undefined || mtime > cutoff) return false;
        const raw =
          file.path === stateFile(id)
            ? position.stateRaw
            : file.path === markerFile(id)
              ? position.marker
              : readFile(file.path);
        if (!sweepable(raw)) return false;
        // A malformed paired file cannot resurrect a session, but a parseable one can.
        if (file.marker && position.exists && sweepable(position.stateRaw)) return false;
        remove(file.path);
        if (file.path === stateFile(id)) position.exists = false;
        return true;
      },
      false,
      'E_SESSION_STATE'
    );
    if (deleted) swept++;
  }
  return swept;
}

/** Recovery finalizes pending tails before sweeping, using one locked snapshot per session. */
export function maintainSessions(
  currentSessionId: string,
  project: string,
  host: InboxHost,
  config: MehmoryConfig,
  options: { idleMs?: number; maxAgeDays?: number; finalizePending?: boolean; sweep?: boolean } = {}
): { finalized: number; swept: number } {
  let finalized = 0;
  let swept = 0;
  const sessions = new Map<string, ReturnType<typeof sessionFiles>>();
  for (const file of failOpen(sessionFiles, [], 'E_SESSION_STATE')) {
    const files = sessions.get(file.id) ?? [];
    files.push(file);
    sessions.set(file.id, files);
  }
  const idleCutoff = Date.now() - (options.idleMs ?? PENDING_IDLE_MS);
  const ageCutoff =
    Date.now() - (options.maxAgeDays ?? config.session_state.max_age_days) * 24 * 60 * 60 * 1000;
  for (const [id, files] of sessions) {
    // Warm files need neither transition; avoid contending with their live hooks.
    const eligible = files.some((file) => {
      try {
        const mtime = stat(file.path)?.mtimeMs;
        return (
          mtime !== undefined &&
          ((options.sweep !== false && mtime <= ageCutoff) ||
            (options.finalizePending !== false &&
              !file.marker &&
              id.trim() !== '' &&
              id !== currentSessionId &&
              mtime <= idleCutoff))
        );
      } catch {
        return false;
      }
    });
    if (!eligible) continue;
    failOpen(
      () =>
        withSessionLock(id, () => {
          const position = loadPosition(id, false);
          const stateFileEntry = files.find((file) => !file.marker);
          if (
            options.finalizePending !== false &&
            id.trim() !== '' &&
            id !== currentSessionId &&
            stateFileEntry &&
            pending(position, stateFileEntry.path, idleCutoff)
          ) {
            const completed = failOpen(
              () => {
                const state = position.state;
                const result = finalize(
                  position,
                  state.transcript_path,
                  state.project_key ?? project,
                  state.host ?? host,
                  config,
                  {}
                );
                return !result.markerFailed;
              },
              false,
              'E_SESSION_STATE'
            );
            if (completed) finalized++;
            if (
              position.marker !== undefined &&
              !files.some((file) => file.path === markerFile(id))
            ) {
              files.push({ path: markerFile(id), id, marker: true });
            }
          }
          if (options.sweep !== false) {
            const cutoff =
              Date.now() -
              (options.maxAgeDays ?? config.session_state.max_age_days) * 24 * 60 * 60 * 1000;
            swept += sweep(position, files, cutoff);
          }
        }),
      undefined,
      'E_SESSION_STATE'
    );
  }
  return { finalized, swept };
}
