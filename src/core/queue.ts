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
 * Enqueue a job with the given data and optional type. Returns the job ID, or null on failure.
 * The job type is stored in the job payload and can be filtered when claiming.
 */
export function enqueueJob(jobData: Record<string, unknown>, jobType?: string): string | null {
  const jobId = randomBytes(8).toString('hex');
  const queueDir = join(statePath('queue'));
  const jobPath = join(queueDir, `${jobId}.json`);

  mkdir(queueDir);
  // Store the jobType in the payload so it can be filtered during claim
  const payload = { ...jobData };
  if (jobType !== undefined) {
    payload._jobType = jobType;
  }
  const contents = JSON.stringify(payload, null, 2);

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
 * When jobType is specified, only jobs matching that type are claimed.
 * Returns the claimed job ID and its data, or null if no job was claimed.
 */
export function claimJob(jobType?: string): { readonly id: string; readonly data: Record<string, unknown> } | null {
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

  // List claimed files once before the loop (fixing O(n) repeated directory reads)
  const claimedFiles = pathExists(claimedDir) ? listDir(claimedDir) : [];

  // Try to claim the first available job
  for (const jobFile of jobs) {
    const jobPath = join(queueDir, jobFile);
    const jobId = jobFile.replace('.json', '');

    // Parse the job to check its type before attempting to claim it
    let jobData: Record<string, unknown>;
    try {
      const contents = readFile(jobPath);
      const parsed: unknown = JSON.parse(contents);
      jobData =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      // Job file is malformed/unreadable; skip it
      continue;
    }

    // Filter by job type if specified
    if (jobType !== undefined) {
      const payloadType = jobData._jobType;
      if (payloadType !== jobType) {
        // This job is not the type we're looking for; skip it
        continue;
      }
    }

    // Count existing claims for this job in claimed/
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
    const claimedPath = join(claimedDir, `${jobId}.${String(process.pid)}.json`);

    try {
      rename(jobPath, claimedPath);
      // We won! Return the job data.
      return { id: jobId, data: jobData };
    } catch {
      // Rename failed; someone else claimed it or job doesn't exist. Try next job.
      continue;
    }
  }

  return null;
}
