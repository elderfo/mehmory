import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { recordWarning, pendingWarnings, peekWarnings } from '../src/core/errors.js';
import { statePath } from '../src/core/home.js';

const workerPrefix = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
let paused = false;
fs.readFileSync = function(path, ...args) {
  const data = read(path, ...args);
  if (!paused && /\\/(warnings\\.json|warning-records\\/)/.test(String(path))) {
    paused = true;
    process.stdout.write('reading\\n');
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
  }
  return data;
};
syncBuiltinESMExports();
const m = await import('./dist/core/errors.js');
`;

function worker(script: string): {
  reading: Promise<void>;
  resume: () => void;
  done: Promise<string>;
} {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerPrefix + script], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'pipe',
  });
  let output = '';
  let error = '';
  let markReading: () => void = () => {};
  let rejectReading: (error: Error) => void = () => {};
  const reading = new Promise<void>((resolve, reject) => {
    markReading = resolve;
    rejectReading = reject;
  });
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
    if (output.includes('reading\n')) markReading();
  });
  child.stderr.on('data', (data: Buffer) => {
    error += data.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const done = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!output.includes('reading\n'))
        rejectReading(new Error('worker did not reach the read barrier'));
      if (code === 0) resolve(output);
      else reject(new Error(error || `worker exit ${String(code)}`));
    });
  });
  return { reading, resume: () => child.stdin.end('x'), done };
}

describe('warning storage races', () => {
  it('retains a warning recorded while another process drains', async () => {
    recordWarning('E_CONFIG_PARSE');
    const drain = worker('console.log(JSON.stringify(m.pendingWarnings()));');
    try {
      await drain.reading;
      recordWarning('E_LOCK_TIMEOUT');
    } finally {
      drain.resume();
    }
    const output = await drain.done;
    expect(output).toContain('E_CONFIG_PARSE');
    expect(pendingWarnings()).toEqual([
      `E_LOCK_TIMEOUT (informational, 1 occurrences): see ${statePath('errors.log')}`,
    ]);
  });

  it('retains both codes when two processes record concurrently', async () => {
    recordWarning('E_CONFIG_PARSE');
    const first = worker("m.recordWarning('E_LOCK_TIMEOUT');");
    try {
      await first.reading;
      recordWarning('E_DISTILL_LOSSY');
    } finally {
      first.resume();
    }
    await first.done;
    expect(
      peekWarnings()
        .map((line) => line.split(' ')[0])
        .sort()
    ).toEqual(['E_CONFIG_PARSE', 'E_DISTILL_LOSSY', 'E_LOCK_TIMEOUT']);
  });

  it('allows only one process to consume each published record', async () => {
    recordWarning('E_CONFIG_PARSE');
    const drain = worker('console.log(JSON.stringify(m.pendingWarnings()));');
    let second: readonly string[];
    try {
      await drain.reading;
      second = pendingWarnings();
    } finally {
      drain.resume();
    }
    expect(await drain.done).toContain('E_CONFIG_PARSE');
    expect(second).toEqual([]);
    expect(peekWarnings()).toEqual([]);
  });

  it('uses MEHMORY_HOME in warning details', () => {
    recordWarning('E_CONFIG_PARSE');
    expect(peekWarnings()).toEqual([
      `E_CONFIG_PARSE (actionable, 1 occurrences): see ${statePath('errors.log')}`,
    ]);
  });

  it('fails open when the warning directory cannot be created', () => {
    const original = process.env['MEHMORY_HOME'];
    const blocker = statePath('warning-blocker');
    mkdirSync(dirname(blocker), { recursive: true });
    writeFileSync(blocker, 'file');
    process.env['MEHMORY_HOME'] = join(blocker, 'home');
    try {
      expect(() => {
        recordWarning('E_CONFIG_PARSE');
      }).not.toThrow();
      expect(peekWarnings()).toEqual([]);
      expect(pendingWarnings()).toEqual([]);
      expect(readFileSync(blocker, 'utf8')).toBe('file');
    } finally {
      process.env['MEHMORY_HOME'] = original;
    }
  });
});
