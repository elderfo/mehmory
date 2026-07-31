/**
 * `mehmory onboard` — mining the transcripts Claude Code has already written into the
 * inbox (plan criterion 5). A17: all of the behavior is here; the command file parses
 * flags and formats lines.
 *
 * The hard part is not distilling — that is run 1's `readTranscript`/`distill` path —
 * it is deciding *which project* a `~/.claude/projects/<encoded>` directory belongs to.
 * The encoding is lossy (`/`, `\` and `.` all become `-`), so the only honest decode is
 * one that walks the real filesystem and accepts a candidate solely because it exists.
 * A directory that no longer decodes to anything is reported `unresolvable` and skipped;
 * guessing a key here would silently file one project's memory under another's name.
 */

import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { listDir, pathExists, readFile, stat } from './fs.js';
import { statePath } from './home.js';
import { failOpen, logError } from './errors.js';
import { resolveProjectKey } from './identity.js';
import { appendInboxEntries } from './inbox.js';
import { atomicWrite, remove } from './fs.js';
import { redact } from './redact.js';
import type { MehmoryConfig } from './config.js';
import { inboxEntryId, type InboxEntry } from '../schema/format.js';
import { readTranscript } from '../transcript/reader.js';
import { distill } from '../distill/distill.js';

/** Transcript directories to scan before the rest are reported unscanned. */
export const DEFAULT_PROJECT_SCAN = 50;
/** Transcripts to distill, newest first. */
export const DEFAULT_SESSION_CAP = 30;
/** Distilled-output ceiling in bytes. */
export const DEFAULT_MAX_BYTES = 512000;

/** What `onboard` tells a user with nothing to mine (U13). */
export const NO_TRANSCRIPTS_MESSAGE =
  'no transcripts found — run `/mehmory:onboard-session` inside a Claude Code session in your project instead';

/** One `<session-id>.jsonl` under a transcript directory. */
export interface TranscriptSession {
  readonly id: string;
  readonly file: string;
  readonly bytes: number;
  readonly mtime: number;
}

/** One `~/.claude/projects/<encoded>` directory, resolved as far as it can be. */
export interface TranscriptDir {
  /** Directory name as Claude Code wrote it. */
  readonly encoded: string;
  /** Decoded filesystem path, or undefined when it no longer exists. */
  readonly path: string | undefined;
  /** `resolveProjectKey()` run *in* that path, or undefined when unresolvable. */
  readonly key: string | undefined;
  readonly sessions: readonly TranscriptSession[];
}

export interface ScanResult {
  readonly dirs: readonly TranscriptDir[];
  /** Encoded names whose decoded path is gone. Listed, never guessed. */
  readonly unresolvable: readonly string[];
  /** Directories past the `--projects` cap. */
  readonly unscanned: number;
}

/** `~/.claude/projects`. Reads `HOME`, so a test's fake home is honored. */
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

function isDirectory(path: string): boolean {
  try {
    return stat(path)?.isDirectory() === true;
  } catch {
    return false;
  }
}

/** The encoding Claude Code applies to a project path (see `test/helpers.ts`). */
function encodeSegment(name: string): string {
  return name.replace(/[/\\.]/g, '-');
}

/**
 * Decode a transcript directory name back to the filesystem path it was made from.
 *
 * `-` in the encoded name is ambiguous — it may stand for `/`, `.` or a literal `-` —
 * so this does not invert the encoding. It descends the real filesystem, at each level
 * accepting only an entry that actually exists and whose own encoding is a prefix of
 * what is left. A path that no longer exists therefore returns `undefined` rather than
 * a plausible-looking guess.
 */
export function decodeClaudeProjectDir(encoded: string): string | undefined {
  const walk = (dir: string, rest: string): string | undefined => {
    if (rest === '') return dir;
    if (!rest.startsWith('-')) return undefined;

    let names: string[];
    try {
      names = listDir(dir);
    } catch {
      return undefined;
    }

    for (const name of names) {
      const candidate = '-' + encodeSegment(name);
      if (!rest.startsWith(candidate)) continue;
      const tail = rest.slice(candidate.length);
      if (tail !== '' && !tail.startsWith('-')) continue;
      const child = join(dir, name);
      if (!isDirectory(child)) continue;
      const found = walk(child, tail);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return walk(sep, encoded);
}

function sessionsIn(dir: string): readonly TranscriptSession[] {
  const sessions: TranscriptSession[] = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    let bytes = 0;
    let mtime = 0;
    try {
      const info = stat(file);
      if (info?.isFile() !== true) continue;
      bytes = Number(info.size);
      mtime = Number(info.mtimeMs);
    } catch {
      continue;
    }
    sessions.push({ id: name.slice(0, -'.jsonl'.length), file, bytes, mtime });
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Scan `~/.claude/projects/`, newest directory first, up to `limit`.
 *
 * Capped because each uncached directory costs a `git` subprocess (`resolveProjectKey`)
 * and the directory count is the user's, not ours. Never throws: an absent or
 * unreadable `~/.claude` scans as empty.
 */
export function scanTranscripts(limit: number = DEFAULT_PROJECT_SCAN): ScanResult {
  return failOpen(
    () => {
      const root = claudeProjectsDir();
      if (!pathExists(root)) return { dirs: [], unresolvable: [], unscanned: 0 };

      const all = listDir(root)
        .filter(name => isDirectory(join(root, name)))
        .map(name => ({ name, mtime: Number(stat(join(root, name))?.mtimeMs ?? 0) }))
        .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));

      const dirs: TranscriptDir[] = [];
      const unresolvable: string[] = [];
      for (const { name } of all.slice(0, limit)) {
        const path = decodeClaudeProjectDir(name);
        if (path === undefined) {
          unresolvable.push(name);
          continue;
        }
        dirs.push({
          encoded: name,
          path,
          key: resolveProjectKey(path),
          sessions: sessionsIn(join(root, name)),
        });
      }
      return { dirs, unresolvable, unscanned: Math.max(0, all.length - limit) };
    },
    { dirs: [], unresolvable: [], unscanned: 0 },
    'E_TRANSCRIPT_READ'
  );
}

// ─── The run ───

export interface OnboardOptions {
  /** Project key, or `global` when `isGlobal`. Also the state file's scope stamp. */
  readonly scopeLabel: string;
  /** `<home>/projects/<key>` or `<home>/global`. */
  readonly scopeDir: string;
  /** `--global`: mine every resolved project's transcripts into the global inbox. */
  readonly isGlobal: boolean;
  readonly dryRun: boolean;
  readonly resume: boolean;
  readonly sessions: number;
  readonly maxBytes: number;
  readonly projects: number;
  readonly config: MehmoryConfig;
}

export interface OnboardResult {
  readonly scan: ScanResult;
  /** Transcripts belonging to the selected scope, before the caps. */
  readonly candidates: number;
  /** Transcripts actually read this run (a resumed run counts only its own). */
  readonly distilled: number;
  /** Transcripts skipped because a previous run already did them (`--resume`). */
  readonly alreadyDone: number;
  readonly entries: number;
  readonly appended: number;
  readonly skipped: number;
  /** Distilled bytes, against `--max-bytes`. */
  readonly bytes: number;
  readonly cappedByBytes: boolean;
  readonly stub: string | undefined;
}

export type OnboardOutcome =
  | { readonly kind: 'ok'; readonly result: OnboardResult }
  /** `--resume` with nothing to resume. */
  | { readonly kind: 'no-state' }
  /** `--resume` under different scope flags than the interrupted run used. */
  | { readonly kind: 'scope-mismatch'; readonly recorded: string };

/** Where an interrupted run's progress lives. Under `.state/`, so it is gitignored. */
export function onboardStateFile(): string {
  return statePath('onboard.json');
}

interface OnboardState {
  readonly scope: string;
  readonly done: readonly string[];
}

function readState(): OnboardState | undefined {
  const file = onboardStateFile();
  if (!pathExists(file)) return undefined;
  return failOpen<OnboardState | undefined>(
    () => {
      const parsed: unknown = JSON.parse(readFile(file));
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const record = parsed as Record<string, unknown>;
      const scope = record['scope'];
      const done = record['done'];
      if (typeof scope !== 'string') return undefined;
      return {
        scope,
        done: Array.isArray(done) ? done.filter((d): d is string => typeof d === 'string') : [],
      };
    },
    undefined,
    'E_SESSION_STATE'
  );
}

function writeState(state: OnboardState): void {
  failOpen(
    () => {
      atomicWrite(onboardStateFile(), JSON.stringify(state));
    },
    undefined,
    'E_SESSION_STATE'
  );
}

function clearState(): void {
  failOpen(
    () => {
      if (pathExists(onboardStateFile())) remove(onboardStateFile());
    },
    undefined,
    'E_SESSION_STATE'
  );
}

/** The one-line `project.md` that keeps `storeIsUnpopulated()` from firing (U13). */
export function onboardStub(label: string): string {
  return `# ${label}\n\nSeeded by \`mehmory onboard\`. Run \`/mehmory:integrate\` to turn the inbox into pages.\n`;
}

/**
 * Distill one transcript into inbox entries.
 *
 * `config.secrets` is threaded into `distill` as well as applied again here: `distill`
 * is where content is first materialized and this is the write boundary, and criterion
 * 14 puts the filter at both. Never throws — an unreadable transcript is one skipped
 * session plus an `errors.log` line, not a failed onboard (criterion 20).
 */
function distillSession(session: TranscriptSession, config: MehmoryConfig): InboxEntry[] {
  return failOpen(
    () => {
      const { records } = readTranscript(session.file);
      const ts = new Date().toISOString();
      return distill(records, session.id, config.secrets).map(entry => ({
        id: inboxEntryId(entry.id),
        text: redact(entry.content, config.secrets),
        src: entry.source.sessionId,
        ts,
      }));
    },
    [],
    'E_TRANSCRIPT_READ'
  );
}

/**
 * Mine transcripts into the selected scope's inbox.
 *
 * Recent-first, capped, redacted, and appended by id, so a second run — or a `--resume`
 * that re-reads a transcript the interrupted run had already appended — is a no-op
 * rather than a duplicate.
 */
export function runOnboard(options: OnboardOptions): OnboardOutcome {
  const state = options.resume ? readState() : undefined;
  if (options.resume) {
    if (state === undefined) return { kind: 'no-state' };
    if (state.scope !== options.scopeLabel) {
      return { kind: 'scope-mismatch', recorded: state.scope };
    }
  }

  const scan = scanTranscripts(options.projects);
  if (!options.dryRun) {
    for (const encoded of scan.unresolvable) {
      logError({
        code: 'E_TRANSCRIPT_DIR_UNRESOLVED',
        kind: 'informational',
        what: `\`${encoded}\` decodes to a path that no longer exists`,
        consequence: 'That transcript directory was skipped, not guessed at',
      });
    }
  }

  const matching = scan.dirs.filter(
    dir => options.isGlobal || (dir.key !== undefined && dir.key === options.scopeLabel)
  );
  const candidates = matching
    .flatMap(dir => dir.sessions)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, options.sessions);

  const done = new Set(state?.done ?? []);
  if (!options.dryRun) writeState({ scope: options.scopeLabel, done: [...done] });

  const inboxFile = join(options.scopeDir, 'inbox.md');
  let distilled = 0;
  let alreadyDone = 0;
  let entries = 0;
  let appended = 0;
  let skipped = 0;
  let bytes = 0;
  let cappedByBytes = false;

  for (const session of candidates) {
    if (done.has(session.file)) {
      alreadyDone++;
      continue;
    }
    if (bytes >= options.maxBytes) {
      cappedByBytes = true;
      break;
    }

    const produced = distillSession(session, options.config);
    distilled++;
    entries += produced.length;
    bytes += produced.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf-8'), 0);

    if (!options.dryRun && produced.length > 0) {
      const written = appendInboxEntries(inboxFile, produced, options.scopeLabel);
      appended += written.appended;
      skipped += written.skipped;
    }
    done.add(session.file);
    if (!options.dryRun) writeState({ scope: options.scopeLabel, done: [...done] });
  }

  // The stub is not cosmetic: `storeIsUnpopulated()` reads `project.md` and `pages/`,
  // not the inbox, so without it the very next SessionStart tells a user who just
  // onboarded that their memory is empty and points them at the rival surface (U13).
  let stub: string | undefined;
  const stubFile = join(options.scopeDir, 'project.md');
  if (!options.dryRun && candidates.length > 0 && !pathExists(stubFile)) {
    failOpen(
      () => {
        atomicWrite(stubFile, onboardStub(options.scopeLabel));
      },
      undefined,
      'E_ATOMIC_WRITE'
    );
    if (pathExists(stubFile)) stub = stubFile;
  }

  if (!options.dryRun) clearState();

  return {
    kind: 'ok',
    result: {
      scan,
      candidates: candidates.length,
      distilled,
      alreadyDone,
      entries,
      appended,
      skipped,
      bytes,
      cappedByBytes,
      stub,
    },
  };
}
