/**
 * `mehmory doctor` — criterion 8.
 *
 * Exits 0 / 5 / 6 and **never 2**: a missing store is the finding this command exists to
 * report, so it lands as an error-level finding naming `mehmory init`, not as the generic
 * "no store" exit every other command uses.
 */

import { runDoctor, worstLevel, type Finding } from '../../core/doctor.js';
import { parseFlags } from '../args.js';
import { EXIT, usageError, type Command, type ExitCode } from '../command.js';
import { REQUIRED_NODE } from '../package-info.js';

export const command: Command = {
  name: 'doctor',
  summary: 'run the health check list and print a copy-paste remedy for each problem',
  usage: 'mehmory doctor [--json]',
  help: [
    '  --json            emit the single-line JSON envelope instead of text',
    '',
    '  Exits 0 when every check passes, 5 on warnings only, 6 on any error.',
  ],

  run(ctx) {
    const parsed = parseFlags(ctx.argv, {});
    if (!parsed.ok) return usageError(parsed.what, 'mehmory doctor --help');
    if (parsed.positional.length > 0) {
      return usageError(
        `\`doctor\` takes no arguments (got \`${parsed.positional[0] ?? ''}\`)`,
        'mehmory doctor'
      );
    }

    const findings = runDoctor(ctx.config, REQUIRED_NODE, ctx.cwd);
    const level = worstLevel(findings);
    const exit: ExitCode =
      level === 'error' ? EXIT.DOCTOR_ERROR : level === 'warn' ? EXIT.DOCTOR_WARN : EXIT.OK;

    const lines = findings.flatMap(finding => {
      const head = `[${finding.level}] ${finding.check}: ${finding.message}`;
      return finding.fix === undefined ? [head] : [head, `        fix: ${finding.fix}`];
    });

    // U13: end on the single highest-priority remedy, so the reader has one next action
    // rather than a list to triage.
    const next = firstRemedy(findings);
    if (next !== undefined) lines.push(`next: ${next}`);

    return {
      exit,
      // `ok` is not `exit === 0` here: exit 5 means the checks ran and found things worth
      // saying, which is a successful doctor run.
      ok: level !== 'error',
      lines,
      // The `[warn]`/`[error]` lines above are the human rendering; the arrays below
      // exist for the envelope only.
      selfRendered: true,
      data: { level, findings },
      warnings: findings.filter(f => f.level === 'warn').map(f => f.message),
      errors: findings
        .filter(f => f.level === 'error')
        .map(f => ({
          // A check that names a documented cause reports under that cause's registry
          // code; everything else keeps the derived `E_DOCTOR_<CHECK>` shape.
          code: f.code ?? `E_DOCTOR_${f.check.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
          what: f.message,
          consequence: 'The check failed',
          ...(f.fix !== undefined ? { fix: f.fix } : {}),
        })),
    };
  },
};

/** The remedy of the first error finding, else of the first warning. */
function firstRemedy(findings: readonly Finding[]): string | undefined {
  return (
    findings.find(f => f.level === 'error' && f.fix !== undefined)?.fix ??
    findings.find(f => f.level === 'warn' && f.fix !== undefined)?.fix
  );
}
