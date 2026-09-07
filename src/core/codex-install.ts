/**
 * Wiring mehmory into the Codex CLI, and probing the result for `doctor` (issue #21).
 *
 * Two files under `$CODEX_HOME` (`~/.codex` by default) are involved, and **neither is
 * mehmory's**: `hooks.json` is shared with every other tool that registers a Codex hook,
 * and `config.toml` is the user's whole Codex configuration. So both edits are merges,
 * never rewrites — mehmory adds and removes only entries it can positively identify as
 * its own, and everything else survives byte-for-byte.
 *
 * Identification is `CODEX_HOOK_MARKER`, a trailing argv token on the command mehmory
 * writes. It is deliberately **not** the command's path: the bundle path moves with every
 * plugin version, and matching on it would turn a version bump into a duplicate entry
 * instead of a replacement. The hook adapters read only `argv[2]` (the host), so the
 * marker is inert at runtime.
 *
 * Nothing here throws: an absent, malformed or unwritable file comes back as a typed
 * error (A2, A11), because clobbering a config that mehmory could not parse would take
 * out the tools that own the rest of it.
 */

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, listDir, lstat, pathExists, readFile, remove, removeDir } from './fs.js';
import { codexHome } from './home.js';
import { withProjectLock } from './lock.js';
import { HOOK_EVENTS, type HookConfigKey } from './environment.js';
import { failOpen, shellQuote, type MehmoryError } from './errors.js';
import type { InboxHost } from '../schema/format.js';

/**
 * Trailing argv token marking a `hooks.json` command entry as mehmory's own.
 *
 * Read by nothing at runtime; it exists so that re-running the install replaces the
 * previous entries rather than appending a second set, and so that uninstall can remove
 * mehmory's entries without touching anybody else's.
 */
export const CODEX_HOOK_MARKER = '--mehmory';

/** Backup written next to a Codex file before mehmory modifies it. */
export const CODEX_BACKUP_SUFFIX = '.mehmory.bak';

/**
 * The hooks mehmory registers with Codex: every event in `HOOK_EVENTS`.
 *
 * `session_end` used to be excluded, on a measurement against Codex CLI 0.146.0 that
 * found no session-end event. Codex has one now: a sentinel hook registered on
 * `SessionEnd` under 0.153.4 fires with the same `{session_id, transcript_path, cwd,
 * hook_event_name, reason}` payload Claude Code sends. Wiring it is what stops Codex
 * depending solely on the next session's start to capture a session's tail (issue #51).
 *
 * Derived from `HOOK_EVENTS` rather than re-listed, so a new event added there is wired
 * on both harnesses or explicitly excluded here.
 */
export const CODEX_HOOK_KEYS: readonly HookConfigKey[] = Object.keys(
  HOOK_EVENTS
) as HookConfigKey[];

/** Codex event names mehmory wires, in the order it writes them. */
export const CODEX_HOOK_EVENTS: readonly string[] = CODEX_HOOK_KEYS.map(key => HOOK_EVENTS[key]);

/**
 * `SessionStart` → `session_start`. `hooks.json` names events in PascalCase; the
 * `[hooks.state]` trust keys in `config.toml` name the same events in snake_case.
 */
function configKeyFor(event: string): string {
  return CODEX_HOOK_KEYS.find(key => HOOK_EVENTS[key] === event) ?? event;
}

// ─── Paths ───

/** `$CODEX_HOME/hooks.json` — the shared hook registry. */
export function codexHooksFile(): string {
  return join(codexHome(), 'hooks.json');
}

/** `$CODEX_HOME/config.toml` — where the `[features] hooks` flag lives. */
export function codexConfigFile(): string {
  return join(codexHome(), 'config.toml');
}

/**
 * Resolve `<pkg-root>/<name>`, searching up from the running module until `valid`
 * accepts a candidate.
 *
 * Shared by every "find a sibling directory of this package" lookup below: the CLI, the
 * hook bundles and the skill sources all ship in the same package (`<pkg>/dist/cli.mjs`,
 * `<pkg>/hooks/session-start.mjs`, `<pkg>/skills/<name>/SKILL.md`), so the binary the
 * user just ran is always the right anchor, whether it came from npm or a checkout.
 */
function resolvePackageDir(name: string, valid: (_candidate: string) => boolean): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let up = 0; up < 4; up++) {
    dir = dirname(dir);
    const candidate = join(dir, name);
    if (valid(candidate)) return candidate;
  }
  return join(dirname(start), name);
}

/**
 * Directory holding the built hook bundles this binary should point Codex at.
 *
 * The `.mjs` probe matters: `src/hooks/` holds the TypeScript sources under the same
 * name, and pointing Codex at those would register commands node cannot run.
 */
export function codexHookBundlesDir(): string {
  return resolvePackageDir('hooks', candidate =>
    CODEX_HOOK_KEYS.every(key => pathExists(join(candidate, bundleName(key))))
  );
}

/** Directory holding the shipped skill sources (`skills/<name>/SKILL.md`). */
function codexSkillSourceDir(): string {
  return resolvePackageDir('skills', candidate => pathExists(candidate) && listDir(candidate).length > 0);
}

/** `$CODEX_HOME/skills` — where Codex looks for flat, prefix-named skill directories. */
export function codexSkillsDir(): string {
  return join(codexHome(), 'skills');
}

/** True for a Codex skill directory name mehmory owns — `mehmory` or `mehmory-*`. */
function isMehmorySkillDirName(name: string): boolean {
  return name === 'mehmory' || name.startsWith('mehmory-');
}

/** Codex skill directory name for one shipped skill: `remember` → `mehmory-remember`. */
function codexSkillDirName(skillName: string): string {
  return `mehmory-${skillName}`;
}

// ─── Results ───

export interface CodexReport {
  readonly hooksFile: string;
  readonly configFile: string;
  /** Codex events mehmory's entries now occupy (empty after uninstall). */
  readonly events: readonly string[];
  /** Files actually rewritten — empty when the install was already in place. */
  readonly changed: readonly string[];
  /** Backups taken, one per file about to change. */
  readonly backups: readonly string[];
  /** What happened to `[features] hooks`. Uninstall never turns it off. */
  readonly featureFlag: 'enabled' | 'already-on' | 'untouched';
  /** Skill directory names installed under `codexSkillsDir()` (empty after uninstall). */
  readonly skills: readonly string[];
}

export type CodexResult =
  | { readonly ok: true; readonly report: CodexReport }
  | { readonly ok: false; readonly error: MehmoryError };

// ─── Install / uninstall ───

/**
 * Merge mehmory's hook entries into Codex's config, turn the hooks feature on, and copy
 * the six skills into `codexSkillsDir()` — the doctor check `codex.skills` (`E_CODEX_SKILLS_MISSING`)
 * cannot pass without the latter.
 */
interface FileSnapshot {
  readonly path: string;
  readonly contents: string | undefined;
}

function snapshotFile(path: string): FileSnapshot {
  return { path, contents: pathExists(path) ? readFile(path) : undefined };
}

function restoreSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.contents === undefined) {
    if (pathExists(snapshot.path)) remove(snapshot.path);
  } else {
    atomicWrite(snapshot.path, snapshot.contents);
  }
}

export function installCodex(host: InboxHost): CodexResult {
  return (
    withProjectLock('__codex__', () => installCodexUnlocked(host), 50, 100, false) ?? {
      ok: false,
      error: {
        code: 'E_CODEX_INSTALL',
        kind: 'actionable',
        what: 'another Codex installation is in progress',
        consequence: 'Codex configuration was not changed',
        fix: 'retry the install after the other process finishes',
      },
    }
  );
}

function installCodexUnlocked(host: InboxHost): CodexResult {
  let snapshots: readonly FileSnapshot[];
  try {
    snapshots = [snapshotFile(codexHooksFile()), snapshotFile(codexConfigFile())];
  } catch (err) {
    return { ok: false, error: writeFailed(codexHome(), err) };
  }
  const wired = editCodex(doc => withMehmoryHooks(doc, host), true);
  if (!wired.ok) return wired;

  const skills = writeCodexSkills();
  if (!skills.ok) {
    try {
      for (const snapshot of snapshots) restoreSnapshot(snapshot);
    } catch {
      // The original error remains actionable and the per-file backups remain available.
    }
    return skills;
  }

  return {
    ok: true,
    report: {
      ...wired.report,
      changed: [...wired.report.changed, ...skills.changed],
      skills: skills.names,
    },
  };
}

/**
 * Remove mehmory's hook entries and skill directories, leaving every other tool's
 * entries, the feature flag, and any foreign `skills/` directory alone.
 */
export function uninstallCodex(): CodexResult {
  return (
    withProjectLock('__codex__', () => uninstallCodexUnlocked(), 50, 100, false) ?? {
      ok: false,
      error: {
        code: 'E_CODEX_INSTALL',
        kind: 'actionable',
        what: 'another Codex installation is in progress',
        consequence: 'Codex configuration was not changed',
        fix: 'retry the uninstall after the other process finishes',
      },
    }
  );
}

function uninstallCodexUnlocked(): CodexResult {
  let snapshots: readonly FileSnapshot[];
  try {
    snapshots = [snapshotFile(codexHooksFile()), snapshotFile(codexConfigFile())];
  } catch (err) {
    return { ok: false, error: writeFailed(codexHome(), err) };
  }
  const wired = editCodex(withoutMehmoryHooks, false);
  if (!wired.ok) return wired;

  const removed = removeCodexSkills();
  if (!removed.ok) {
    try {
      for (const snapshot of snapshots) restoreSnapshot(snapshot);
    } catch {
      // Preserve the removal error; the backups remain available.
    }
    return removed;
  }

  return {
    ok: true,
    report: { ...wired.report, changed: [...wired.report.changed, ...removed.changed], skills: [] },
  };
}

interface SkillWriteResult {
  readonly ok: true;
  /** Skill directory names written, e.g. `mehmory-remember`. */
  readonly names: readonly string[];
  /** Files actually written — empty when every skill was already up to date. */
  readonly changed: readonly string[];
}

interface SkillRemoveResult {
  readonly ok: true;
  /** Directories actually removed. */
  readonly changed: readonly string[];
}

type SkillResult = SkillWriteResult | { readonly ok: false; readonly error: MehmoryError };

/**
 * Copy every shipped `skills/<name>/SKILL.md` verbatim into
 * `codexSkillsDir()/mehmory-<name>/SKILL.md`.
 *
 * A copy, not a symlink: the source lives inside the installed package (or a checkout
 * that may move or be removed independently of `$CODEX_HOME`), so a symlink would go
 * stale exactly when a `pnpm build`/npm upgrade replaces it. Re-running only rewrites a
 * skill whose body actually changed, so a plain re-install reports nothing changed.
 */
function assertNoSymlinkComponents(path: string): void {
  let current = path;
  for (;;) {
    try {
      if (lstat(current)?.isSymbolicLink()) throw new Error(`refusing symlink component ${current}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('refusing symlink')) throw err;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function writeCodexSkills(): SkillResult {
  const sourceDir = codexSkillSourceDir();
  if (!pathExists(sourceDir)) {
    return {
      ok: false,
      error: {
        code: 'E_CODEX_INSTALL',
        kind: 'actionable',
        what: `no skill sources found at ${sourceDir}`,
        consequence: 'no mehmory skill was installed for Codex',
        fix: 'pnpm build',
      },
    };
  }

  const skillNames = listDir(sourceDir).filter(name => pathExists(join(sourceDir, name, 'SKILL.md')));
  const changed: string[] = [];
  const names: string[] = [];
  const originals = new Map<string, string | undefined>();

  try {
    assertNoSymlinkComponents(codexSkillsDir());
    const sources = skillNames.map(skillName => ({
      skillName,
      body: readFile(join(sourceDir, skillName, 'SKILL.md')),
    }));
    for (const { skillName, body } of sources) {
      const dirName = codexSkillDirName(skillName);
      const target = join(codexSkillsDir(), dirName, 'SKILL.md');
      assertNoSymlinkComponents(target);
      const previous = pathExists(target) ? readFile(target) : undefined;
      if (previous !== body) {
        originals.set(target, previous);
        atomicWrite(target, body);
        changed.push(target);
      }
      names.push(dirName);
    }
  } catch (err) {
    for (const [target, previous] of originals) {
      try {
        if (previous === undefined) remove(target);
        else atomicWrite(target, previous);
      } catch {
        // Preserve the original install error; the backup is still available.
      }
    }
    return { ok: false, error: writeFailed(codexSkillsDir(), err) };
  }

  return { ok: true, names, changed };
}

/**
 * Remove every `mehmory` / `mehmory-*` directory under `codexSkillsDir()`.
 *
 * Swept by name rather than by diffing against the shipped skill list, so uninstall
 * still cleans up a directory left behind by a version whose skill set has since
 * changed. Anything not matching the reserved prefix — a foreign skill directory —
 * survives untouched, the same property `uninstallCodex()` holds for `hooks.json`.
 */
function removeCodexSkills(): SkillRemoveResult | { readonly ok: false; readonly error: MehmoryError } {
  const dir = codexSkillsDir();
  if (!pathExists(dir)) return { ok: true, changed: [] };

  const changed: string[] = [];
  try {
    for (const name of listDir(dir)) {
      if (!isMehmorySkillDirName(name)) continue;
      const target = join(dir, name);
      removeDir(target);
      changed.push(target);
    }
  } catch (err) {
    return { ok: false, error: writeFailed(dir, err) };
  }
  return { ok: true, changed };
}

function editCodex(
  transform: (_doc: JsonObject) => JsonObject,
  enableFeature: boolean
): CodexResult {
  const hooksFile = codexHooksFile();
  const configFile = codexConfigFile();
  const changed: string[] = [];
  const backups: string[] = [];

  const existing = readJsonObject(hooksFile);
  if (!existing.ok) return existing;

  let originalConfig: string | undefined;
  if (enableFeature) {
    try {
      originalConfig = pathExists(configFile) ? readFile(configFile) : '';
    } catch (err) {
      return { ok: false, error: writeFailed(configFile, err) };
    }
  }

  let rendered: string;
  try {
    rendered = renderHooksDoc(transform(existing.value), existing.raw);
  } catch (err) {
    return { ok: false, error: writeFailed(hooksFile, err) };
  }
  try {
    if (existing.raw !== rendered) {
      const saved = backupFile(hooksFile);
      if (saved !== undefined) backups.push(saved);
      atomicWrite(hooksFile, rendered);
      changed.push(hooksFile);
    }
  } catch (err) {
    return { ok: false, error: writeFailed(hooksFile, err) };
  }

  let featureFlag: CodexReport['featureFlag'] = 'untouched';
  if (enableFeature) {
    const next = enableHooksFeature(originalConfig ?? '');
    if (next === undefined) {
      featureFlag = 'already-on';
    } else {
      try {
        const saved = backupFile(configFile);
        if (saved !== undefined) backups.push(saved);
        atomicWrite(configFile, next, pathExists(configFile) ? undefined : 0o600);
      } catch (err) {
        try {
          if (existing.raw === undefined) remove(hooksFile);
          else atomicWrite(hooksFile, existing.raw);
        } catch {
          // Preserve the original install error; the backup remains available.
        }
        return { ok: false, error: writeFailed(configFile, err) };
      }
      changed.push(configFile);
      featureFlag = 'enabled';
    }
  }

  return {
    ok: true,
    report: {
      hooksFile,
      configFile,
      events: mehmoryEvents(readJsonObjectOrEmpty(hooksFile)),
      changed,
      backups,
      // Overwritten by installCodex/uninstallCodex with the real skill directory list —
      // editCodex() only knows about hooks.json and config.toml.
      skills: [],
      featureFlag,
    },
  };
}

function writeFailed(path: string, err: unknown): MehmoryError {
  return {
    code: 'E_CODEX_INSTALL',
    kind: 'actionable',
    what: err instanceof Error ? err.message : String(err),
    consequence: `${path} was not modified, so the Codex integration is not in place`,
    fix: `ls -l ${shellQuote(dirname(path))}`,
  };
}

/**
 * Copy a file to `<path>.mehmory.bak` before it is modified. No file, no backup.
 *
 * Written once and never again: the backup's job is to hold the *pre-mehmory* state, and
 * a re-install — routine after a version bump moves the bundle path — would otherwise
 * overwrite it with a mehmory-modified copy, destroying the one file a user reaches for
 * after a bad merge. An existing backup is returned as-is.
 *
 * Forced to 0600 because it is a verbatim duplicate of a file that may be 0600 itself:
 * `config.toml` carries `[mcp_servers.*.env]` API keys, and `~/.codex` is 0755.
 */
function backupFile(path: string): string | undefined {
  if (!pathExists(path)) return undefined;
  const destination = path + CODEX_BACKUP_SUFFIX;
  if (pathExists(destination)) return destination;
  atomicWrite(destination, readFile(path), 0o600);
  return destination;
}

// ─── hooks.json merge ───

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ReadJsonResult =
  | { readonly ok: true; readonly value: JsonObject; readonly raw: string | undefined }
  | { readonly ok: false; readonly error: MehmoryError };

/**
 * Parse `hooks.json`, treating "absent" and "present but broken" as different things.
 *
 * Absent is the normal first install. Broken is a refusal: the file belongs to other
 * tools too, and overwriting content mehmory could not read would silently unregister
 * them (A2, A8).
 */
function readJsonObject(path: string): ReadJsonResult {
  if (!pathExists(path)) return { ok: true, value: {}, raw: undefined };
  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    return { ok: false, error: unparseable(path, err instanceof Error ? err.message : String(err)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: unparseable(path, err instanceof Error ? err.message : String(err)) };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, error: unparseable(path, 'the top level is not a JSON object') };
  }
  return { ok: true, value: parsed, raw };
}

function unparseable(path: string, what: string): MehmoryError {
  return {
    code: 'E_CODEX_INSTALL',
    kind: 'actionable',
    what,
    consequence: `${path} was left exactly as it is, so no hook registration was changed`,
    fix: `$EDITOR ${shellQuote(path)}`,
  };
}

function readJsonObjectOrEmpty(path: string): JsonObject {
  const result = readJsonObject(path);
  return result.ok ? result.value : {};
}

/**
 * The exact bytes mehmory writes: Codex's own 2-space indentation, and whichever
 * trailing-newline convention the file already had.
 *
 * The newline matters more than it looks. Uninstall must return a file that held only
 * foreign entries to *byte-identical*, and Codex's own writer leaves no trailing newline —
 * so unconditionally appending one would show up as a spurious diff in the user's dotfile
 * repository every time mehmory was installed and removed.
 */
function renderHooksDoc(doc: JsonObject, previous: string | undefined): string {
  const json = JSON.stringify(doc, null, 2);
  return previous !== undefined && !previous.endsWith('\n') ? json : json + '\n';
}

/** Built bundle file for one hook: `session_start` → `session-start.mjs`. */
function bundleName(key: HookConfigKey): string {
  return `${key.replace(/_/g, '-')}.mjs`;
}

/**
 * The command Codex runs for one mehmory hook.
 *
 * The path is always single-quoted, with embedded quotes escaped POSIX-style. Quoting
 * only when the path contains whitespace left `/Users/o'brien/…` — not exotic — producing
 * a command Codex mis-parses. Not attacker-reachable (the path comes from
 * `resolvePackageDir` walking up from `import.meta.url`), so this is robustness.
 */
function hookCommand(key: HookConfigKey, host: InboxHost, bundlesDir: string): string {
  const bundle = join(bundlesDir, bundleName(key));
  const quoted = `'${bundle.replace(/'/g, `'\\''`)}'`;
  return `node ${quoted} ${host} ${CODEX_HOOK_MARKER}`;
}

/** True for a `{type, command}` entry mehmory wrote. */
function isMehmoryHook(entry: unknown): boolean {
  if (!isJsonObject(entry) || entry['type'] !== 'command') return false;
  const command = entry['command'];
  if (typeof command !== 'string') return false;
  const match = /^node\s+(.+)\s+(claude-code|codex)\s+--mehmory$/.exec(command);
  if (!match) return false;
  const rawPath = match[1] ?? '';
  const bundle = rawPath.startsWith("'")
    ? rawPath.slice(1, -1).replace(/'\\''/g, "'")
    : rawPath;
  return CODEX_HOOK_KEYS.some(key => basename(bundle) === bundleName(key));
}

/**
 * Drop mehmory's hook entries and nothing else.
 *
 * Prunes bottom-up — a group whose `hooks` array empties is dropped, an event whose
 * group array empties is dropped — so uninstall leaves a valid file rather than a shell
 * of empty arrays. A group that mixes mehmory and foreign entries keeps the foreign ones.
 */
function withoutMehmoryHooks(doc: JsonObject): JsonObject {
  const hooks = doc['hooks'];
  if (!isJsonObject(hooks)) return doc;

  const kept: JsonObject = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const survivors = (groups as readonly unknown[]).flatMap(group => {
      if (!isJsonObject(group) || !Array.isArray(group['hooks'])) return [group];
      const entries = (group['hooks'] as readonly unknown[]).filter(e => !isMehmoryHook(e));
      if (entries.length === 0) return [];
      return [{ ...group, hooks: entries }];
    });
    if (survivors.length > 0) kept[event] = survivors;
  }
  return { ...doc, hooks: kept };
}

/**
 * Replace mehmory's entries with a fresh set — strip first, then append.
 *
 * That is what makes a re-install idempotent in the way that matters: an install whose
 * bundle path or host argument changed replaces its old entry instead of adding a
 * second one, and running it twice unchanged produces identical bytes.
 */
function withMehmoryHooks(doc: JsonObject, host: InboxHost): JsonObject {
  const existingHooks = doc['hooks'];
  if (existingHooks !== undefined && !isJsonObject(existingHooks)) {
    throw new Error('hooks.json has an unsupported hooks shape');
  }
  const stripped = withoutMehmoryHooks(doc);
  const existing = stripped['hooks'];
  const hooks: JsonObject = isJsonObject(existing) ? { ...existing } : {};
  const bundlesDir = codexHookBundlesDir();

  for (const key of CODEX_HOOK_KEYS) {
    const event = HOOK_EVENTS[key];
    const current = hooks[event];
    const groups = Array.isArray(current) ? [...(current as readonly unknown[])] : [];
    groups.push({ hooks: [{ type: 'command', command: hookCommand(key, host, bundlesDir) }] });
    hooks[event] = groups;
  }
  return { ...stripped, hooks };
}

/** Codex events that currently carry at least one mehmory entry. */
function mehmoryEvents(doc: JsonObject): readonly string[] {
  const hooks = doc['hooks'];
  if (!isJsonObject(hooks)) return [];
  return Object.entries(hooks)
    .filter(
      ([, groups]) =>
        Array.isArray(groups) &&
        (groups as readonly unknown[]).some(
          group =>
            isJsonObject(group) &&
            Array.isArray(group['hooks']) &&
            (group['hooks'] as readonly unknown[]).some(isMehmoryHook)
        )
    )
    .map(([event]) => event);
}

// ─── config.toml `[features] hooks` ───

/**
 * Turn `[features] hooks` on, returning the new file text — or `undefined` when it is
 * already on and nothing needs writing.
 *
 * A line edit, not a parse-and-re-serialize. `config.toml` holds the user's models,
 * MCP servers, per-project trust levels and Codex's own hook-trust hashes; round-tripping
 * it through a TOML library would reformat all of that to change one boolean.
 */
export function enableHooksFeature(toml: string): string | undefined {
  if (readHooksFeature(toml) === true) return undefined;

  const lines = toml.split('\n');
  const section = featuresSection(lines);
  if (section === undefined) {
    const separator = toml === '' || toml.endsWith('\n') ? '' : '\n';
    return `${toml}${separator}\n[features]\nhooks = true\n`;
  }

  const keyLine = findHooksKey(lines, section);
  const next = [...lines];
  if (keyLine === undefined) {
    next.splice(section.start + 1, 0, 'hooks = true');
  } else {
    next[keyLine] = 'hooks = true';
  }
  return next.join('\n');
}

/** The `[features] hooks` value: `true`, `false`, or `undefined` when it is unset. */
export function readHooksFeature(toml: string): boolean | undefined {
  const lines = toml.split('\n');
  const section = featuresSection(lines);
  if (section === undefined) return undefined;
  const keyLine = findHooksKey(lines, section);
  if (keyLine === undefined) return undefined;
  const value = /=\s*([^#]*)/.exec(lines[keyLine] ?? '')?.[1]?.trim();
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/**
 * Codex events that `config.toml` records a hook-trust decision for, in `hooks.json`.
 *
 * Codex will not run a registered hook until it has been reviewed and approved. Approval
 * writes `[hooks.state."<hooks.json>:<event>:<group>:<index>"]` carrying a `trusted_hash`;
 * until then the hook is silently skipped, with no warning on any surface (issue #39).
 * `doctor` reads these keys because a wired-but-unreviewed install is otherwise
 * indistinguishable from a working one.
 *
 * Matched on the `<hooks.json>:<event>:` prefix rather than the whole key, because the
 * trailing indices depend on where mehmory's group landed among other tools'. That makes
 * this a presence check, not a validity check: it catches the never-reviewed install,
 * which is the reported failure, and cannot detect a `trusted_hash` gone stale because
 * mehmory cannot compute Codex's hash.
 *
 * An entry explicitly turned off (`enabled = false`) counts as untrusted: the user
 * reviewed it and declined, and the hook does not run either way.
 */
export function readTrustedHookEvents(toml: string, hooksFile: string): readonly string[] {
  const header = /^\s*\[hooks\.state\."(.+)"\]\s*$/;
  const lines = toml.split('\n');
  const trusted = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const key = header.exec(lines[i] ?? '')?.[1];
    if (key === undefined || !key.startsWith(`${hooksFile}:`)) continue;
    const event = key.slice(hooksFile.length + 1).split(':')[0];
    if (event === undefined || event === '') continue;
    if (!sectionDisabled(lines, i)) trusted.add(event);
  }
  return [...trusted];
}

/** True when the TOML table starting at `start` sets `enabled = false`. */
function sectionDisabled(lines: readonly string[], start: number): boolean {
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? '')) return false;
    if (/^\s*enabled\s*=\s*false\b/.test(lines[i] ?? '')) return true;
  }
  return false;
}

interface SectionRange {
  readonly start: number;
  readonly end: number;
}

/** Line range of the `[features]` table, header included, next header excluded. */
function featuresSection(lines: readonly string[]): SectionRange | undefined {
  const start = lines.findIndex(line => line.trim() === '[features]');
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? '')) return { start, end: i };
  }
  return { start, end: lines.length };
}

function findHooksKey(lines: readonly string[], section: SectionRange): number | undefined {
  for (let i = section.start + 1; i < section.end; i++) {
    if (/^\s*hooks\s*=/.test(lines[i] ?? '')) return i;
  }
  return undefined;
}

// ─── Probe (doctor) ───

export interface CodexProbe {
  readonly codexHome: string;
  readonly hooksFile: string;
  readonly configFile: string;
  /** True when Codex itself has a configuration here — i.e. the harness has been run. */
  readonly harnessPresent: boolean;
  /** `[features] hooks`, or `undefined` when unset or unreadable. */
  readonly hooksFeature: boolean | undefined;
  /** `hooks.json` exists but does not parse — nothing can be said about wiring. */
  readonly hooksFileBroken: boolean;
  /** Codex events mehmory's entries occupy. */
  readonly wiredEvents: readonly string[];
  /** Codex events mehmory should occupy but does not. */
  readonly missingEvents: readonly string[];
  /**
   * Codex events mehmory has wired but Codex has no trust decision for, so they do not
   * run. Empty when nothing is wired, or when every wired event has been reviewed.
   */
  readonly untrustedEvents: readonly string[];
  /** True when at least one `mehmory*` skill directory is installed for Codex. */
  readonly skillsInstalled: boolean;
}

/**
 * Everything `doctor` needs to describe the Codex surface. Never throws (A2).
 *
 * `readJsonObject` and `readHooksFeature` both read a file that exists but may not be
 * readable — a root-owned or mode-000 `~/.codex/config.toml` raises EACCES, and `doctor`
 * calls this unwrapped, which turned the *diagnostic* command into a generic failure.
 * Wrapped in `failOpen` like every sibling probe in `environment.ts`: an unreadable
 * surface reports as unknown, which is what a diagnostic should say.
 */
export function probeCodexInstall(): CodexProbe {
  const home = codexHome();
  const hooksFile = codexHooksFile();
  const configFile = codexConfigFile();

  // A file that is there but cannot be read is exactly `hooksFileBroken`: present, and
  // nothing can be said about the wiring inside it.
  const unreadable: CodexProbe = {
    codexHome: home,
    hooksFile,
    configFile,
    harnessPresent: pathExists(configFile),
    hooksFeature: undefined,
    hooksFileBroken: pathExists(hooksFile),
    wiredEvents: [],
    missingEvents: CODEX_HOOK_EVENTS,
    untrustedEvents: [],
    skillsInstalled: false,
  };

  return failOpen(
    () => {
      const parsed = readJsonObject(hooksFile);
      const wiredEvents = parsed.ok ? mehmoryEvents(parsed.value) : [];
      const configToml = pathExists(configFile) ? readFile(configFile) : undefined;
      const trusted =
        configToml === undefined ? [] : readTrustedHookEvents(configToml, hooksFile);

      return {
        codexHome: home,
        hooksFile,
        configFile,
        harnessPresent: pathExists(configFile),
        hooksFeature: configToml === undefined ? undefined : readHooksFeature(configToml),
        hooksFileBroken: !parsed.ok,
        wiredEvents,
        missingEvents: CODEX_HOOK_EVENTS.filter(event => !wiredEvents.includes(event)),
        untrustedEvents: wiredEvents.filter(event => !trusted.includes(configKeyFor(event))),
        skillsInstalled: hasCodexSkills(home),
      };
    },
    unreadable,
    'E_CODEX_INSTALL'
  );
}

/**
 * Codex keeps skills flat under `$CODEX_HOME/skills/`, namespaced by prefix rather than
 * by directory, so mehmory's are `mehmory` / `mehmory-*` — the same directories
 * `writeCodexSkills()` writes and `removeCodexSkills()` sweeps.
 */
function hasCodexSkills(home: string): boolean {
  const dir = join(home, 'skills');
  if (!pathExists(dir)) return false;
  try {
    return listDir(dir).some(isMehmorySkillDirName);
  } catch {
    return false;
  }
}
