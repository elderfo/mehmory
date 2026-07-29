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

/** Construct a path under <home>/.state/ */
export function statePath(...segments: string[]): string {
  return join(mehmoryHome(), '.state', ...segments);
}
