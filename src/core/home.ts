import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of the mehmory store. Honors MEHMORY_HOME, else ~/.mehmory. Never creates it. */
export function mehmoryHome(): string {
  const envHome = process.env.MEHMORY_HOME;
  if (envHome) {
    return envHome;
  }
  return join(homedir(), '.mehmory');
}

/** Root of the Codex CLI's configuration. Honors CODEX_HOME, else ~/.codex. Never creates it. */
export function codexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome) {
    return envHome;
  }
  return join(homedir(), '.codex');
}

/** Construct a path under <home>/.state/ */
export function statePath(...segments: string[]): string {
  return join(mehmoryHome(), '.state', ...segments);
}
