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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, listDir, pathExists, readFile, removeDir } from './fs.js';
import { codexHome } from './home.js';
import { HOOK_EVENTS, type HookConfigKey } from './environment.js';
import type { MehmoryError } from './errors.js';
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
 * The hooks mehmory registers with Codex: every event except `session_end`.
 *
 * Codex has no session-end event — measured against Codex CLI 0.146.0, see
 * `.research/codex-spike/VERDICT.md`. Derived from `HOOK_EVENTS` rather than re-listed,
 * so a new event added there is wired on both harnesses or explicitly excluded here.
 */
export const CODEX_HOOK_KEYS: readonly HookConfigKey[] = (
  Object.keys(HOOK_EVENTS) as HookConfigKey[]
).filter(key => key !== 'session_end');

/** Codex event names mehmory wires, in the order it writes them. */
export const CODEX_HOOK_EVENTS: readonly string[] = CODEX_HOOK_KEYS.map(key => HOOK_EVENTS[key]);

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
export function installCodex(host: InboxHost): CodexResult {
  const wired = editCodex(doc => withMehmoryHooks(doc, host), true);
  if (!wired.ok) return wired;

  const skills = writeCodexSkills();
  if (!skills.ok) return skills;

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
  const wired = editCodex(withoutMehmoryHooks, false);
  if (!wired.ok) return wired;

  const removed = removeCodexSkills();
  if (!removed.ok) return removed;

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

  try {
    for (const skillName of skillNames) {
      const body = readFile(join(sourceDir, skillName, 'SKILL.md'));
      const dirName = codexSkillDirName(skillName);
      const target = join(codexSkillsDir(), dirName, 'SKILL.md');
      if (!pathExists(target) || readFile(target) !== body) {
        atomicWrite(target, body);
        changed.push(target);
      }
      names.push(dirName);
    }
  } catch (err) {
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

  const rendered = renderHooksDoc(transform(existing.value), existing.raw);
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
    const toml = pathExists(configFile) ? readFile(configFile) : '';
    const next = enableHooksFeature(toml);
    if (next === undefined) {
      featureFlag = 'already-on';
    } else {
      try {
        const saved = backupFile(configFile);
        if (saved !== undefined) backups.push(saved);
        atomicWrite(configFile, next);
      } catch (err) {
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
    fix: `ls -l ${dirname(path)}`,
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
  const raw = readFile(path);
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
    fix: `$EDITOR ${path}`,
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

/** The command Codex runs for one mehmory hook. */
function hookCommand(key: HookConfigKey, host: InboxHost, bundlesDir: string): string {
  const bundle = join(bundlesDir, bundleName(key));
  const quoted = /\s/.test(bundle) ? `'${bundle}'` : bundle;
  return `node ${quoted} ${host} ${CODEX_HOOK_MARKER}`;
}

/** True for a `{type, command}` entry mehmory wrote. */
function isMehmoryHook(entry: unknown): boolean {
  if (!isJsonObject(entry)) return false;
  const command = entry['command'];
  return typeof command === 'string' && command.split(/\s+/).includes(CODEX_HOOK_MARKER);
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
  /** True when at least one `mehmory*` skill directory is installed for Codex. */
  readonly skillsInstalled: boolean;
}

/** Everything `doctor` needs to describe the Codex surface. Never throws (A2). */
export function probeCodexInstall(): CodexProbe {
  const home = codexHome();
  const hooksFile = codexHooksFile();
  const configFile = codexConfigFile();

  const parsed = readJsonObject(hooksFile);
  const wiredEvents = parsed.ok ? mehmoryEvents(parsed.value) : [];

  return {
    codexHome: home,
    hooksFile,
    configFile,
    harnessPresent: pathExists(configFile),
    hooksFeature: pathExists(configFile) ? readHooksFeature(readFile(configFile)) : undefined,
    hooksFileBroken: !parsed.ok,
    wiredEvents,
    missingEvents: CODEX_HOOK_EVENTS.filter(event => !wiredEvents.includes(event)),
    skillsInstalled: hasCodexSkills(home),
  };
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
