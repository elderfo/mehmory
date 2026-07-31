/**
 * The fixed `mehmory doctor` check list (criterion 8).
 *
 * Every check returns a `Finding`, never an exit code — A11 keeps `process.exit` out of
 * core, and A17 leaves the 0/5/6 mapping and the formatting to `src/cli/`. Every finding
 * with a real remedy carries a **runnable** command in `fix`; a check whose remedy would
 * be prose carries none (U10).
 */

import { join } from 'node:path';
import { mehmoryHome, statePath } from './home.js';
import { pathExists, readFile, stat } from './fs.js';
import { failOpen } from './errors.js';
import { readInboxEntries } from './inbox.js';
import { resolveProjectKey } from './identity.js';
import { TEMPLATE_SCHEMA_VERSION } from './store.js';
import { HOOK_EVENTS, PLUGIN_INSTALL_COMMANDS, checkNodeVersion, probePlugin } from './environment.js';
import { dirtyPaths, lastCommit, lastIntegrate, scopeFiles } from './status.js';
import { readStats, summarize } from './stats-report.js';
import type { MehmoryConfig } from './config.js';

export type FindingLevel = 'ok' | 'warn' | 'error';

/** One check's verdict. */
export interface Finding {
  /** Stable check id, safe to grep and to key documentation on. */
  readonly check: string;
  readonly level: FindingLevel;
  readonly message: string;
  /** A runnable copy-paste command, when one exists (U10). */
  readonly fix?: string;
}

/**
 * KPI budgets, from the **amended** numbers (run-1 amendment 1, run-2 amendments 10 and
 * 14) rather than the spec's stale KPI table, which run 3 rewrites separately.
 */
export const KPI_BUDGETS = {
  /** Injection plus maintenance lines, as SessionStart records it. */
  combinedInjectionTokens: 950,
  /** UserPromptSubmit, in-hook. */
  userPromptSubmitMs: 100,
  /** SessionStart, the injection path. */
  sessionStartMs: 1000,
} as const;

/** Age at which the newest stats line means "the hooks have stopped reporting". */
const HOOK_SILENCE_MS = 14 * 24 * 60 * 60 * 1000;

/** Age at which an un-integrated inbox is worth mentioning. */
const INBOX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Run every check.
 *
 * A missing store short-circuits the store-dependent half: `doctor` is the command that
 * exists to report it, so it says so once with `mehmory init` as the remedy rather than
 * emitting a dozen derived failures (criterion 2 — `doctor` never exits 2).
 */
export function runDoctor(
  config: MehmoryConfig,
  requiredNode: string,
  cwd: string = process.cwd()
): readonly Finding[] {
  const findings: Finding[] = [checkNode(requiredNode), ...checkPlugin()];

  const home = mehmoryHome();
  if (!pathExists(join(home, 'global', 'identity.md'))) {
    findings.push({
      check: 'store',
      level: 'error',
      message: `no mehmory store at ${home}`,
      fix: 'mehmory init',
    });
    return findings;
  }
  findings.push({ check: 'store', level: 'ok', message: `store at ${home}` });

  findings.push(...checkGit(home));
  findings.push(...checkHookConfig(config));
  findings.push(...checkHookLiveness());
  findings.push(...checkScope(config, cwd));
  findings.push(checkErrorLog());
  findings.push(checkSchemaVersion(home));
  findings.push(checkConfigParses(home));
  findings.push(...checkKpiBudgets());

  return findings;
}

/** `ok` when nothing fired, `warn` when only warnings did, `error` on any error. */
export function worstLevel(findings: readonly Finding[]): FindingLevel {
  if (findings.some(f => f.level === 'error')) return 'error';
  if (findings.some(f => f.level === 'warn')) return 'warn';
  return 'ok';
}

// ─── Individual checks ───

function checkNode(required: string): Finding {
  const node = checkNodeVersion(required);
  if (node.ok) {
    return { check: 'node', level: 'ok', message: `node ${node.current} (requires ${node.required})` };
  }
  return {
    check: 'node',
    level: 'error',
    message: `node ${node.current} is below the required ${node.required}`,
    // nvm is the one upgrade path that is a command rather than a download page.
    fix: 'nvm install 22 && nvm use 22',
  };
}

function checkPlugin(): readonly Finding[] {
  const probe = probePlugin();
  if (!probe.installed) {
    return [
      {
        check: 'plugin',
        level: 'error',
        message: 'the mehmory plugin is not installed, so no hook will ever fire',
        // Slash commands: prefixed because `doctor` runs in a shell (U13).
        fix: `in a Claude Code session, run \`${PLUGIN_INSTALL_COMMANDS.join('` then `')}\``,
      },
    ];
  }

  const expected = Object.values(HOOK_EVENTS);
  const missing = expected.filter(event => !probe.registeredEvents.includes(event));
  if (missing.length > 0) {
    return [
      {
        check: 'plugin',
        level: 'error',
        message: `the installed plugin registers no ${missing.join(', ')} hook`,
        fix: `in a Claude Code session, run \`${PLUGIN_INSTALL_COMMANDS[1] ?? ''}\``,
      },
    ];
  }
  return [
    {
      check: 'plugin',
      level: 'ok',
      message: `plugin installed at ${probe.installPath ?? '(unknown)'}, all ${String(expected.length)} hooks registered`,
    },
  ];
}

function checkGit(home: string): readonly Finding[] {
  const findings: Finding[] = [];
  const gitignore = join(home, '.gitignore');

  if (!pathExists(gitignore)) {
    findings.push({
      check: 'git.gitignore',
      level: 'warn',
      // Without it `.state/` is always untracked, so "tree clean" can never be true
      // and the crash signal it carries is worthless (plan gap 12).
      message: 'the store has no .gitignore, so .state/ is always untracked',
      fix: `printf '.state/\\n' > ${gitignore}`,
    });
  } else {
    findings.push({ check: 'git.gitignore', level: 'ok', message: '.gitignore present' });
  }

  const dirty = dirtyPaths();
  const commit = lastCommit();
  const save = `git -C ${home} add -A && git -C ${home} commit -m "manual save"`;

  if (dirty === undefined) {
    findings.push({
      check: 'git.repo',
      level: 'error',
      message: `${home} is not a git repository, so nothing written there is recoverable`,
      fix: `git -C ${home} init`,
    });
    return findings;
  }

  if (commit === undefined) {
    // A store with no commits is also always dirty. Reporting both would say one fact
    // twice; this is the one that names what is actually missing.
    findings.push({
      check: 'git.commit',
      level: 'warn',
      message: 'the store has no commits yet, so nothing in it is recoverable',
      fix: save,
    });
    return findings;
  }

  findings.push(
    dirty.length > 0
      ? {
          check: 'git.clean',
          level: 'warn',
          message: `${String(dirty.length)} uncommitted change(s) in the store`,
          fix: save,
        }
      : { check: 'git.clean', level: 'ok', message: 'working tree clean' }
  );
  findings.push({ check: 'git.commit', level: 'ok', message: `last commit ${commit}` });

  return findings;
}

/**
 * Per-hook `enabled` state (run-2 amendment 17, assigned to run 3's doctor).
 *
 * A disabled hook is a legitimate choice, so this warns rather than errors — but it
 * names the config key, because "capture stopped working" and "capture is switched off"
 * are indistinguishable from the outside.
 */
function checkHookConfig(config: MehmoryConfig): readonly Finding[] {
  const disabled = Object.keys(HOOK_EVENTS).filter(
    name => !config.hooks[name as keyof typeof HOOK_EVENTS].enabled
  );
  if (disabled.length === 0) {
    return [{ check: 'hooks.enabled', level: 'ok', message: 'all five hooks enabled' }];
  }
  return disabled.map(name => ({
    check: `hooks.enabled.${name}`,
    level: 'warn' as const,
    message: `${HOOK_EVENTS[name as keyof typeof HOOK_EVENTS]} is disabled by config key \`hooks.${name}.enabled\``,
    fix: `$EDITOR ${join(mehmoryHome(), 'config.json')}`,
  }));
}

function checkHookLiveness(): readonly Finding[] {
  const records = readStats();
  if (records.length === 0) {
    return [
      {
        check: 'hooks.liveness',
        level: 'warn',
        // No `fix`: the remedy is whatever the plugin check above already said, and
        // U10 forbids inventing a plausible-looking command to fill the clause.
        message: 'no hook has ever reported to stats.jsonl',
      },
    ];
  }

  const findings: Finding[] = [];
  const seen = new Set(records.map(r => r.hook));
  const silent = Object.values(HOOK_EVENTS).filter(event => !seen.has(event));
  if (silent.length > 0) {
    findings.push({
      check: 'hooks.liveness',
      level: 'warn',
      message: `no invocation recorded for ${silent.join(', ')}`,
    });
  }

  const newest = records.map(r => r.ts).sort().at(-1);
  const age = newest === undefined ? undefined : Date.now() - Date.parse(newest);
  if (age !== undefined && Number.isFinite(age) && age > HOOK_SILENCE_MS) {
    findings.push({
      check: 'hooks.silent',
      level: 'warn',
      message: `the newest stats line is ${String(Math.floor(age / 86400000))} days old`,
      fix: `tail -n 20 ${statePath('errors.log')}`,
    });
  }

  if (findings.length === 0) {
    findings.push({
      check: 'hooks.liveness',
      level: 'ok',
      message: `${String(records.length)} hook invocations recorded`,
    });
  }
  return findings;
}

/** Inbox size and age, plus the last integrate, for the current directory's scope. */
function checkScope(config: MehmoryConfig, cwd: string): readonly Finding[] {
  const key = resolveProjectKey(cwd);
  const files = scopeFiles(join(mehmoryHome(), 'projects', key));
  const entries = failOpen(() => readInboxEntries(files.inboxFile), [], 'E_APPEND_FAILED');
  const findings: Finding[] = [];

  const oldest = entries.map(e => e.ts).sort()[0];
  const ageMs = oldest === undefined ? 0 : Date.now() - Date.parse(oldest);
  const stale = Number.isFinite(ageMs) && ageMs > INBOX_STALE_MS;

  if (entries.length >= config.inbox.nudge_entries || (entries.length > 0 && stale)) {
    findings.push({
      check: 'inbox',
      level: 'warn',
      message: `${String(entries.length)} un-integrated inbox entries for ${key}, oldest ${oldest ?? 'unknown'}`,
      fix: 'in a Claude Code session, run `/mehmory:integrate`',
    });
  } else {
    findings.push({
      check: 'inbox',
      level: 'ok',
      message: `${String(entries.length)} inbox entries for ${key}`,
    });
  }

  const integrated = lastIntegrate(files.logFile);
  findings.push({
    check: 'integrate',
    level: 'ok',
    message: integrated === undefined ? 'no integrate recorded yet' : `last integrate ${integrated}`,
  });

  return findings;
}

function checkErrorLog(): Finding {
  const path = statePath('errors.log');
  if (!pathExists(path) || Number(stat(path)?.size ?? 0) === 0) {
    return { check: 'errors', level: 'ok', message: 'errors.log is empty' };
  }
  const lines = readFile(path).split('\n').filter(l => l.trim() !== '');
  const tail = lines.slice(-3).join(' | ');
  return {
    check: 'errors',
    level: 'warn',
    message: `${String(lines.length)} logged errors, most recent: ${tail}`,
    fix: `tail -n 20 ${path}`,
  };
}

/**
 * `schema_version` drift (A20).
 *
 * A narrow, read-only carve-out on A4: exactly one frontmatter key is read, and nothing
 * else in SCHEMA.md is ever parsed. Compared against the template constant `store.ts`
 * ships — not `FORMAT_VERSION`, which versions the machine format and would fire here on
 * every code-only bump with no correct user action.
 */
function checkSchemaVersion(home: string): Finding {
  const path = join(home, 'SCHEMA.md');
  if (!pathExists(path)) {
    return {
      check: 'schema_version',
      level: 'warn',
      message: 'the store has no SCHEMA.md',
      fix: 'mehmory init',
    };
  }
  const match = /^schema_version:\s*"?([^"\n]+)"?\s*$/m.exec(readFile(path));
  const found = match?.[1]?.trim();
  if (found === TEMPLATE_SCHEMA_VERSION) {
    return { check: 'schema_version', level: 'ok', message: `schema_version ${found}` };
  }
  return {
    check: 'schema_version',
    level: 'warn',
    message: `SCHEMA.md is at schema_version ${found ?? '(unset)'}, this build ships ${TEMPLATE_SCHEMA_VERSION}`,
    fix: `$EDITOR ${path}`,
  };
}

function checkConfigParses(home: string): Finding {
  const path = join(home, 'config.json');
  if (!pathExists(path)) {
    return { check: 'config', level: 'ok', message: 'no config.json; running on defaults' };
  }
  try {
    const parsed: unknown = JSON.parse(readFile(path));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('root is not an object');
    }
    return { check: 'config', level: 'ok', message: 'config.json parses' };
  } catch (err) {
    return {
      check: 'config',
      level: 'error',
      message: `config.json is unparseable (${err instanceof Error ? err.message : String(err)}), so every setting is ignored`,
      fix: `$EDITOR ${path}`,
    };
  }
}

function checkKpiBudgets(): readonly Finding[] {
  const report = summarize(readStats());
  if (report.records === 0) return [];

  const findings: Finding[] = [];
  const over = (actual: number | undefined, budget: number): boolean =>
    actual !== undefined && actual > budget;

  if (over(report.injectedTokensP95, KPI_BUDGETS.combinedInjectionTokens)) {
    findings.push({
      check: 'kpi.injection',
      level: 'warn',
      message: `injected tokens p95 is ${String(report.injectedTokensP95)}, over the ${String(KPI_BUDGETS.combinedInjectionTokens)} combined budget`,
      fix: `$EDITOR ${join(mehmoryHome(), 'config.json')}`,
    });
  }

  for (const [event, budget] of [
    [HOOK_EVENTS.user_prompt_submit, KPI_BUDGETS.userPromptSubmitMs],
    [HOOK_EVENTS.session_start, KPI_BUDGETS.sessionStartMs],
  ] as const) {
    const hook = report.hooks.find(h => h.hook === event);
    if (hook && hook.msP95 > budget) {
      findings.push({
        check: `kpi.${event}`,
        level: 'warn',
        message: `${event} p95 is ${String(hook.msP95)} ms, over its ${String(budget)} ms budget`,
        fix: `tail -n 20 ${statePath('errors.log')}`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({ check: 'kpi', level: 'ok', message: 'all KPI budgets within bounds' });
  }
  return findings;
}
