/**
 * Tests for durable queue (done-when 9): enqueueJob, claimJob.
 * Critical test: 5 real concurrent processes claiming 1 job, exactly one wins.
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statePath } from '../src/core/home.js';
import { enqueueJob, claimJob } from '../src/core/queue.js';
import { pathExists, mkdir, listDir } from '../src/core/fs.js';

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
      const claimedPath = join(queueDir, 'claimed', `${jobId}.${String(process.pid)}.json`);
      expect(pathExists(claimedPath)).toBe(true);
    }
  });

  it('concurrent claim test: 5 processes claim 1 job, exactly 1 wins (real concurrency)', { timeout: 30000 }, () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    // Enqueue 1 job
    const jobId = enqueueJob({ target: 'single' });
    expect(jobId).not.toBeNull();
    if (!jobId) throw new Error('Failed to enqueue');

    const testScriptPath = join(statePath(), 'queue-claimer.mjs');
    mkdirSync(dirname(testScriptPath), { recursive: true });
    const repoRoot = '/home/cgetsfred/Developer/mehmory';

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

    const processCount = 5;
    const results: Array<{ success: boolean; id?: string; pid: number }> = [];
    let completed = 0;

    return new Promise<void>((resolve, reject) => {
      // Release only once all workers report ready; fail loudly if they never do,
      // so a boot failure surfaces as a red test rather than a vacuous green one.
      const barrierDeadline = Date.now() + 20000;
      const barrierPoll = setInterval(() => {
        const ready = readdirSync(barrierDir).filter(f => f.startsWith('ready-')).length;
        if (ready >= processCount) {
          clearInterval(barrierPoll);
          writeFileSync(goPath, 'go');
        } else if (Date.now() > barrierDeadline) {
          clearInterval(barrierPoll);
          reject(new Error(`barrier timeout: only ${String(ready)}/${String(processCount)} workers ready`));
        }
      }, 10);

      for (let i = 0; i < processCount; i++) {
        const proc = spawn('node', [testScriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';

        proc.stdout.on('data', (data: Buffer | string) => {
          stdout += data.toString();
        });

        proc.on('exit', () => {
          completed++;

          try {
            if (stdout) {
              const result = JSON.parse(stdout) as { success: boolean; id?: string; pid: number };
              results.push(result);
            }
          } catch {
            reject(new Error(`Failed to parse: ${stdout}`));
            return;
          }

          if (completed === processCount) {
            try {
              const successes = results.filter(r => r.success);
              expect(successes).toHaveLength(1);
              const winner = successes[0];
              if (!winner) throw new Error('No winner');
              expect(winner.id).toBe(jobId);
              expect(pathExists(join(queueDir, `${jobId}.json`))).toBe(false);
              expect(pathExists(join(queueDir, 'claimed', `${jobId}.${String(winner.pid)}.json`))).toBe(true);
              resolve();
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });

        proc.on('error', () => {
          reject(new Error('Worker failed'));
        });
      }
    });
  });

  it('fails job after 3 claim attempts', () => {
    const queueDir = join(statePath('queue'));
    mkdir(queueDir);

    const jobId = enqueueJob({ task: 'will-fail' });
    if (!jobId) throw new Error('Failed to enqueue');

    // Simulate multiple failed claims by creating fake claim records
    const claimedDir = join(queueDir, 'claimed');
    mkdir(claimedDir);

    // Create 3 claim records for this job
    for (let i = 0; i < 3; i++) {
      const claimPath = join(claimedDir, `${jobId}.${String(1000 + i)}.json`);
      writeFileSync(claimPath, JSON.stringify({ attempt: i }));
    }

    // Next claimJob should move the job to failed/
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

  it('claimJob with wrong jobType does not consume another type\'s claim attempts', () => {
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
    const jobClaims = claimedFiles.filter(f => f.startsWith(jobId + '.'));
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
