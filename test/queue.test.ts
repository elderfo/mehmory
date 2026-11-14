/**
 * Tests for durable queue (done-when 9): enqueueJob, claimJob.
 * Critical test: 5 real concurrent processes claiming 1 job, exactly one wins.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statePath } from '../src/core/home.js';
import { enqueueJob, claimJob, completeJob } from '../src/core/queue.js';
import { pathExists, mkdir, listDir } from '../src/core/fs.js';

interface ClaimResult {
  success: boolean;
  id?: string;
  pid: number;
}

async function runClaimers(scriptPath: string, barrierDir: string): Promise<ClaimResult[]> {
  const processCount = 5;
  const workers: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  let barrierPoll: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<ClaimResult[]>((resolve, reject) => {
      const results: ClaimResult[] = [];
      const deadline = Date.now() + 20000;
      barrierPoll = setInterval(() => {
        try {
          const ready = readdirSync(barrierDir).filter((f) => f.startsWith('ready-')).length;
          if (ready >= processCount) {
            clearInterval(barrierPoll);
            writeFileSync(join(barrierDir, 'go'), 'go');
          } else if (Date.now() > deadline) {
            reject(
              new Error(
                `barrier timeout: only ${String(ready)}/${String(processCount)} workers ready`
              )
            );
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, 10);

      for (let i = 0; i < processCount; i++) {
        const proc = spawn(process.execPath, [scriptPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
        workers.push(proc);
        closed.push(
          new Promise<void>((done) => {
            proc.once('close', () => {
              done();
            });
          })
        );
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data: Buffer | string) => {
          stdout += data.toString();
        });
        proc.stderr.on('data', (data: Buffer | string) => {
          stderr += data.toString();
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          try {
            if (code !== 0) throw new Error(`Worker exited with ${String(code)}: ${stderr}`);
            results.push(JSON.parse(stdout) as ClaimResult);
            if (results.length === processCount) resolve(results);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    });
  } finally {
    clearInterval(barrierPoll);
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    }
    await Promise.all(closed);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('durable queue (done-when 9)', () => {
  it('enqueueJob creates a queued job file', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    const jobId = enqueueJob({ msg: 'test' });

    expect(jobId).toBeTruthy();
    expect(jobId).toHaveLength(16); // 8 bytes hex = 16 chars
    if (!jobId) throw new Error('Failed to enqueue');

    const jobPath = join(queueDir, `${jobId}.json`);
    expect(pathExists(jobPath)).toBe(true);

    const contents = readFileSync(jobPath, 'utf-8');
    const data = JSON.parse(contents) as { msg?: string };
    expect(data.msg).toBe('test');
  });

  it('claimJob moves job to claimed/ with process ID', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    const jobId = enqueueJob({ task: 'work' });
    expect(jobId).not.toBeNull();
    if (!jobId) throw new Error('Failed to enqueue');

    const claimed = claimJob();

    expect(claimed).not.toBeNull();
    if (claimed) {
      expect(claimed.id).toBe(jobId);
      expect(claimed.data.task).toBe('work');

      // Job should be in claimed/ directory
      const claimedFiles = listDir(join(queueDir, 'claimed'));
      expect(claimedFiles).toContain(claimed.claimFile);
      expect(claimed.claimFile).toMatch(
        new RegExp(`^${jobId}\\.${String(process.pid)}\\.[0-9a-f]{32}\\.\\d+\\.json$`)
      );
    }
  });

  it('does not reclaim a new claim of a job enqueued hours earlier', () => {
    const id = enqueueJob({ task: 'delayed' }, 'SessionEnd');
    if (!id) throw new Error('Failed to enqueue');
    const oldTime = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(statePath('queue'), `${id}.json`), oldTime, oldTime);

    const first = claimJob('SessionEnd');
    if (!first) throw new Error('Failed to claim');
    expect(first.data).toEqual({ task: 'delayed', _jobType: 'SessionEnd' });
    expect(claimJob('SessionEnd')).toBeNull();
    expect(listDir(join(statePath('queue'), 'claimed'))).toEqual([first.claimFile]);
    completeJob(id, first.claimFile);
    expect(listDir(join(statePath('queue'), 'claimed'))).toEqual([]);
  });

  it('requeues timestamped claims only after their claim time expires', () => {
    const id = '0123456789abcdef';
    const claimFile = `${id}.99999.${'a'.repeat(32)}.${String(Date.now() - 40000)}.json`;
    const claimedDir = join(statePath('queue'), 'claimed');
    mkdir(claimedDir);
    writeFileSync(join(claimedDir, claimFile), JSON.stringify({ task: 'recover' }));

    const recovered = claimJob();
    if (!recovered) throw new Error('Failed to recover');
    expect(recovered.id).toBe(id);
    expect(recovered.data).toEqual({ task: 'recover', _attempts: 1 });
    expect(pathExists(join(claimedDir, claimFile))).toBe(false);
    completeJob(id, recovered.claimFile);
    expect(listDir(claimedDir)).toEqual([]);
  });

  it('completes legacy tokenized claims', () => {
    const id = '0123456789abcdef';
    const claimFile = `${id}.99999.${'b'.repeat(32)}.json`;
    const claimedDir = join(statePath('queue'), 'claimed');
    mkdir(claimedDir);
    writeFileSync(join(claimedDir, claimFile), '{}');
    completeJob(id, claimFile);
    expect(listDir(claimedDir)).toEqual([]);
  });

  it(
    'concurrent claim test: 5 processes claim 1 job, exactly 1 wins (real concurrency)',
    { timeout: 30000 },
    async () => {
      const queueDir = join(statePath('queue'));
      mkdir(queueDir);

      // Enqueue 1 job
      const jobId = enqueueJob({ target: 'single' });
      expect(jobId).not.toBeNull();
      if (!jobId) throw new Error('Failed to enqueue');

      const oldTime = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      utimesSync(join(queueDir, `${jobId}.json`), oldTime, oldTime);

      const testScriptPath = join(statePath(), 'queue-claimer.mjs');
      mkdirSync(dirname(testScriptPath), { recursive: true });
      // Vitest's cwd is the repo root; hardcoding a developer's path breaks on CI.
      const repoRoot = process.cwd();

      // Two-phase barrier. A timer-based release does NOT synchronize these workers:
      // a worker whose node boot outlasts the timer finds the flag already set and
      // never waits, so the claims never overlap and the test cannot observe a
      // non-atomic claim. Release must be conditional on all workers being ready.
      const barrierDir = join(statePath(), 'barrier');
      mkdirSync(barrierDir, { recursive: true });
      const goPath = join(barrierDir, 'go');

      const scriptContent = `import { claimJob } from '${repoRoot}/dist/core/queue.js';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const barrierDir = ${JSON.stringify(barrierDir)};
writeFileSync(join(barrierDir, 'ready-' + process.pid), '');
while (!existsSync(${JSON.stringify(goPath)})) { /* spin until every worker is at the line */ }
const claimed = claimJob();
if (claimed) {
  console.log(JSON.stringify({ success: true, id: claimed.id, pid: process.pid }));
} else {
  console.log(JSON.stringify({ success: false, pid: process.pid }));
}`;
      writeFileSync(testScriptPath, scriptContent);

      const results = await runClaimers(testScriptPath, barrierDir);
      const successes = results.filter((r) => r.success);
      expect(successes).toHaveLength(1);
      const winner = successes[0];
      if (!winner) throw new Error('No winner');
      expect(winner.id).toBe(jobId);
      expect(pathExists(join(queueDir, `${jobId}.json`))).toBe(false);
      expect(
        listDir(join(queueDir, 'claimed')).some((file) =>
          new RegExp(`^${jobId}\\.${String(winner.pid)}\\.[0-9a-f]{32}\\.\\d+\\.json$`).test(file)
        )
      ).toBe(true);
    }
  );

  it('clears barrier polling and stops workers when a worker cannot boot', async () => {
    const barrierDir = join(statePath(), 'failed-barrier');
    mkdir(barrierDir);
    const scriptPath = join(statePath(), 'broken-claimer.mjs');
    writeFileSync(scriptPath, "import './missing-dist.mjs';");
    const poll = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');

    await expect(runClaimers(scriptPath, barrierDir)).rejects.toThrow('Worker exited');
    expect(poll).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(poll.mock.results[0]?.value);
  });

  it('fails job after 3 claim attempts', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    const jobId = enqueueJob({ task: 'will-fail', _attempts: 3 });
    if (!jobId) throw new Error('Failed to enqueue');

    claimJob();

    const failedPath = join(queueDir, 'failed', `${jobId}.json`);
    expect(pathExists(failedPath)).toBe(true);

    const originalPath = join(queueDir, `${jobId}.json`);
    expect(pathExists(originalPath)).toBe(false);
  });

  it('reclaims stale claims (older than queue.stale_ms)', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    const jobId = enqueueJob({ task: 'reclaimable' });
    if (!jobId) throw new Error('Failed to enqueue');

    // Create a stale claim (mtime > 30s ago)
    const claimedDir = join(queueDir, 'claimed');
    mkdir(claimedDir);
    const stalePath = join(claimedDir, `${jobId}.9999.json`);
    writeFileSync(stalePath, JSON.stringify({ stale: true }));

    // Set mtime to past
    const oldTime = Date.now() - 40000; // 40s ago
    utimesSync(stalePath, oldTime / 1000, oldTime / 1000);

    // ClaimJob should reclaim it
    const claimed = claimJob();
    expect(claimed).not.toBeNull();
    if (claimed) {
      expect(claimed.id).toBe(jobId);

      // Stale claim should be gone
      expect(pathExists(stalePath)).toBe(false);
    }
  });

  it('claimJob with jobType filters to jobs of that type', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    // Enqueue two jobs of different types
    const job1Id = enqueueJob({ msg: 'first' }, 'SessionEnd');
    const job2Id = enqueueJob({ msg: 'second' }, 'UserPromptSubmit');

    expect(job1Id).not.toBeNull();
    expect(job2Id).not.toBeNull();

    // Claim a SessionEnd job - should get job1
    const claimed1 = claimJob('SessionEnd');
    expect(claimed1).not.toBeNull();
    if (claimed1) {
      expect(claimed1.id).toBe(job1Id);
      expect(claimed1.data.msg).toBe('first');
    }

    // Claim a UserPromptSubmit job - should get job2
    const claimed2 = claimJob('UserPromptSubmit');
    expect(claimed2).not.toBeNull();
    if (claimed2) {
      expect(claimed2.id).toBe(job2Id);
      expect(claimed2.data.msg).toBe('second');
    }
  });

  it('claimJob without jobType claims any job regardless of type', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    // Enqueue a typed job
    const jobId = enqueueJob({ task: 'any' }, 'SessionEnd');
    expect(jobId).not.toBeNull();

    // Claim without specifying a type - should still succeed
    const claimed = claimJob();
    expect(claimed).not.toBeNull();
    if (claimed) {
      expect(claimed.id).toBe(jobId);
      expect(claimed.data.task).toBe('any');
    }
  });

  it("claimJob with wrong jobType does not consume another type's claim attempts", () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    const jobId = enqueueJob({ task: 'work' }, 'SessionEnd');
    if (!jobId) throw new Error('Failed to enqueue');

    // Try to claim as UserPromptSubmit - should fail and not create a claim record
    const claimed1 = claimJob('UserPromptSubmit');
    expect(claimed1).toBeNull();

    // Check that no claim record was created
    const claimedDir = join(queueDir, 'claimed');
    const claimedFiles = pathExists(claimedDir) ? listDir(claimedDir) : [];
    const jobClaims = claimedFiles.filter((f) => f.startsWith(jobId + '.'));
    expect(jobClaims).toHaveLength(0);

    // Now claim as SessionEnd - should succeed
    const claimed2 = claimJob('SessionEnd');
    expect(claimed2).not.toBeNull();
    if (claimed2) {
      expect(claimed2.id).toBe(jobId);
    }
  });

  it('untyped job can be claimed with explicit type claim or untyped claim', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    // Enqueue a job without a type
    const jobId = enqueueJob({ task: 'untyped' });
    expect(jobId).not.toBeNull();

    // Untyped claim should succeed
    const claimed = claimJob();
    expect(claimed).not.toBeNull();
    if (claimed) {
      expect(claimed.id).toBe(jobId);
      expect(claimed.data.task).toBe('untyped');
    }
  });

  it('typed claim skips untyped jobs', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    // Enqueue an untyped job and a typed job
    const untypedId = enqueueJob({ msg: 'untyped' });
    const typedId = enqueueJob({ msg: 'typed' }, 'SessionEnd');

    expect(untypedId).not.toBeNull();
    expect(typedId).not.toBeNull();
    if (!untypedId) throw new Error('Failed to enqueue');

    // Claiming with type should skip the untyped job and claim the typed one
    const claimed = claimJob('SessionEnd');
    expect(claimed).not.toBeNull();
    if (claimed) {
      expect(claimed.id).toBe(typedId);
      expect(claimed.data.msg).toBe('typed');
    }

    // Untyped job should still be in queue
    const untypedPath = join(queueDir, `${untypedId}.json`);
    expect(pathExists(untypedPath)).toBe(true);
  });

  it('malformed job file is skipped gracefully', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    // Create a malformed job file
    const jobId = randomBytes(8).toString('hex');
    const jobPath = join(queueDir, `${jobId}.json`);
    writeFileSync(jobPath, '{invalid json');

    // Create a valid job
    const validId = enqueueJob({ msg: 'valid' });
    expect(validId).not.toBeNull();

    // ClaimJob should skip the malformed one and claim the valid one
    const claimed = claimJob();
    expect(claimed).not.toBeNull();
    if (claimed) {
      expect(claimed.id).toBe(validId);
    }
  });
});
