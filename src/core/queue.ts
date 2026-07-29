/**
 * Durable job queue (done-when 9): enqueue jobs, claim by atomic rename.
 * Exactly one of N concurrent claimers wins. Stale claims are reclaimable.
 * After 3 failed claims, a job moves to .state/queue/failed/.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { statePath } from './home.js';
import { logError } from './errors.js';
import {
  pathExists,
  stat,
  mkdir,
  rename,
  remove,
  listDir,
  readFile,
  atomicWrite,
  QUEUE_CLAIM_ATTEMPTS,
  QUEUE_STALE_MS,
} from './fs.js';

/**
 * Enqueue a job with the given data. Returns the job ID, or null on failure.
 */
export function enqueueJob(jobData: Record<string, unknown>): string | null {
  const jobId = randomBytes(8).toString('hex');
  const queueDir = join(statePath('queue'));
  const jobPath = join(queueDir, `${jobId}.json`);

  mkdir(queueDir);
  const contents = JSON.stringify(jobData, null, 2);

  try {
    // Write atomically
    atomicWrite(jobPath, contents);
    return jobId;
  } catch (err) {
    logError({
      code: 'E_QUEUE_CLAIM',
      kind: 'informational',
      what: err instanceof Error ? err.message : String(err),
      consequence: 'Job was not enqueued',
    });
    return null;
  }
}

/**
 * Claim a job by atomic rename into claimed/ directory.
 * Exactly one process wins (rename is atomic). Stale claims (older than queue.stale_ms)
 * can be reclaimed by other processes. After 3 attempts, moves to failed/.
 * Returns the claimed job ID and its data, or null if no job was claimed.
 */
export function claimJob(): { readonly id: string; readonly data: Record<string, unknown> } | null {
  const queueDir = join(statePath('queue'));
  const claimedDir = join(queueDir, 'claimed');
  const failedDir = join(queueDir, 'failed');

  // List jobs in queue directory
  if (!pathExists(queueDir)) {
    return null;
  }

  let jobs: string[];
  try {
    jobs = listDir(queueDir).filter(f => f.endsWith('.json'));
  } catch {
    return null;
  }

  if (jobs.length === 0) {
    return null;
  }

  // Try to claim the first available job
  for (const jobFile of jobs) {
    const jobPath = join(queueDir, jobFile);
    const jobId = jobFile.replace('.json', '');

    // Count existing claims for this job in claimed/
    const claimedFiles = pathExists(claimedDir) ? listDir(claimedDir) : [];
    const jobClaims = claimedFiles.filter(f => f.startsWith(jobId + '.'));

    // Clean up stale claims
    jobClaims.forEach(claim => {
      const claimPath = join(claimedDir, claim);
      try {
        const s = stat(claimPath);
        if (!s) return;
        const mtime = typeof s.mtimeMs === 'number' ? s.mtimeMs : 0;
        const age = Date.now() - mtime;
        if (age > QUEUE_STALE_MS) {
          remove(claimPath);
        }
      } catch {
        // Ignore stat/remove errors
      }
    });

    // If this job has already failed 3 times, move to failed/
    const currentClaimCount = jobClaims.length;
    if (currentClaimCount >= QUEUE_CLAIM_ATTEMPTS) {
      mkdir(failedDir);
      try {
        rename(jobPath, join(failedDir, jobId + '.json'));
      } catch {
        // Ignore if already moved
      }
      continue;
    }

    // Try to claim this job with atomic rename
    mkdir(claimedDir);
    const claimedPath = join(claimedDir, `${jobId}.${process.pid}.json`);

    try {
      rename(jobPath, claimedPath);
      // We won! Read and return the job data.
      const contents = readFile(claimedPath);
      const data = JSON.parse(contents);
      return { id: jobId, data };
    } catch {
      // Rename failed; someone else claimed it or job doesn't exist. Try next job.
      continue;
    }
  }

  return null;
}
