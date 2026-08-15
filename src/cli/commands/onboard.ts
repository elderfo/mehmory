/**
 * `mehmory onboard` — criterion 5.
 *
 * Thin by A17: flags in, `runOnboard()` out, lines and an exit code back. The scan,
 * the decode, the caps and the resume state all live in `src/core/onboard.ts`.
 */

import { storeExists } from '../../core/capture.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_PROJECT_SCAN,
  DEFAULT_SESSION_CAP,
  NO_TRANSCRIPTS_MESSAGE,
  onboardStateFile,
  runOnboard,
} from '../../core/onboard.js';
import { flagInteger, parseFlags } from '../args.js';
import { EXIT, storeMissing, usageError, type Command, type CommandResult } from '../command.js';
import { scopeLabel, selectScope, SCOPE_FLAGS } from '../scope.js';

export const command: Command = {
  name: 'onboard',
  summary: 'seed the inbox by distilling existing Claude Code transcripts',
  usage:
    'mehmory onboard [--project [<key>]|--global] [--dry-run] [--sessions N] [--max-bytes N] [--projects N] [--resume]',
  help: [
    '  --project [<key>] one project; bare means the current directory (default)',
    '  --global          distill cross-project preferences into the global inbox',
    '  --dry-run         preview what would be distilled; writes nothing',
    '  --sessions N      transcripts to distill, newest first (default 30)',
    '  --max-bytes N     distilled-output cap in bytes (default 512000)',
    '  --projects N      transcript directories to scan (default 50)',
    '  --resume          continue an interrupted run with the same scope',
    '  --json            emit the single-line JSON envelope instead of text',
  ],

  run(ctx): CommandResult {
    const parsed = parseFlags(ctx.argv, {
      ...SCOPE_FLAGS,
      'dry-run': 'boolean',
      sessions: 'value',
      'max-bytes': 'value',
      projects: 'value',
      resume: 'boolean',
    });
    if (!parsed.ok) return usageError(parsed.what, 'mehmory onboard --help');
    if (parsed.positional.length > 0) {
      return usageError(
        `\`onboard\` takes no arguments (got \`${parsed.positional[0] ?? ''}\`)`,
        'mehmory onboard --help'
      );
    }

    const scoped = selectScope(parsed.flags, ctx.cwd, ctx.config);
    if (!scoped.ok) return scoped.result;
    if (scoped.scope.kind === 'all') {
      return usageError(
        '`onboard` writes one inbox, so `--all` has no meaning',
        'mehmory onboard --global'
      );
    }
    // `--agent` rides in on `SCOPE_FLAGS`, so it parses here for free — and honouring it
    // would create `agents/<name>/inbox.md`, the one file an agent scope may never have
    // (KTD3). Rejected the same way `--all` is, before anything is written.
    if (scoped.scope.kind === 'agent') {
      return usageError(
        '`onboard` writes an inbox and an agent scope has none, so `--agent` has no meaning',
        'mehmory onboard --project'
      );
    }

    const caps: Record<string, number> = {
      sessions: DEFAULT_SESSION_CAP,
      'max-bytes': DEFAULT_MAX_BYTES,
      projects: DEFAULT_PROJECT_SCAN,
    };
    for (const name of Object.keys(caps)) {
      const value = flagInteger(parsed.flags, name);
      if (!value.ok) return usageError(value.what, 'mehmory onboard --help');
      if (value.value !== undefined) caps[name] = value.value;
    }

    if (!storeExists()) return storeMissing('onboard');

    const scope = scoped.scope;
    const label = scopeLabel(scope);
    const dryRun = parsed.flags.has('dry-run');
    const outcome = runOnboard({
      scopeLabel: label,
      scopeDir: scope.dir,
      isGlobal: scope.kind === 'global',
      dryRun,
      resume: parsed.flags.has('resume'),
      sessions: caps['sessions'] ?? DEFAULT_SESSION_CAP,
      maxBytes: caps['max-bytes'] ?? DEFAULT_MAX_BYTES,
      projects: caps['projects'] ?? DEFAULT_PROJECT_SCAN,
      config: ctx.config,
    });

    if (outcome.kind === 'no-state') {
      return usageError(
        `\`--resume\` found no interrupted run (${onboardStateFile()} does not exist)`,
        'mehmory onboard'
      );
    }
    if (outcome.kind === 'scope-mismatch') {
      return usageError(
        `the interrupted run was scoped to \`${outcome.recorded}\`, not \`${label}\``,
        `mehmory onboard --resume ${outcome.recorded === 'global' ? '--global' : `--project ${outcome.recorded}`}`
      );
    }

    const result = outcome.result;
    const data = {
      scope: label,
      dryRun,
      scanned: result.scan.dirs.length,
      unresolvable: result.scan.unresolvable,
      unscanned: result.scan.unscanned,
      candidates: result.candidates,
      distilled: result.distilled,
      alreadyDone: result.alreadyDone,
      entries: result.entries,
      appended: result.appended,
      skipped: result.skipped,
      bytes: result.bytes,
      cappedByBytes: result.cappedByBytes,
      stub: result.stub,
    };

    // Nothing to mine is a normal outcome, not a failure: it means the user has no
    // prior transcripts for this scope, and the in-session surface is where they
    // should start instead (U13, criterion 5).
    if (result.candidates === 0) {
      return { exit: EXIT.OK, lines: [NO_TRANSCRIPTS_MESSAGE], data };
    }

    const lines = [
      `scope    ${label}${dryRun ? ' (dry run — nothing written)' : ''}`,
      `scanned  ${String(result.scan.dirs.length)} transcript directories`,
      `sessions ${String(result.distilled)} distilled of ${String(result.candidates)} matching${result.alreadyDone > 0 ? `, ${String(result.alreadyDone)} already done` : ''}`,
      `entries  ${String(result.entries)} distilled, ${dryRun ? '0 appended (dry run)' : `${String(result.appended)} appended, ${String(result.skipped)} already in the inbox`}`,
    ];
    if (result.scan.unresolvable.length > 0) {
      lines.push(
        `unresolvable ${String(result.scan.unresolvable.length)}: ${result.scan.unresolvable.join(', ')}`
      );
    }
    if (result.scan.unscanned > 0) {
      lines.push(
        `unscanned ${String(result.scan.unscanned)} more directories — raise \`--projects\` to include them`
      );
    }
    if (result.cappedByBytes) {
      lines.push('stopped at the `--max-bytes` cap; re-run to continue');
    }
    if (result.stub !== undefined) lines.push(`wrote    ${result.stub}`);
    if (!dryRun) lines.push('next: in a Claude Code session, run `/mehmory:integrate`');

    return { exit: EXIT.OK, lines, data };
  },
};
