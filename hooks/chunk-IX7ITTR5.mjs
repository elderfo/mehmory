import {
  QUEUE_CLAIM_ATTEMPTS,
  QUEUE_STALE_MS,
  atomicWrite,
  listDir,
  logError,
  mkdir,
  pathExists,
  readFile,
  remove,
  rename,
  stat,
  statePath
} from "./chunk-FK65OKCK.mjs";

// src/core/queue.ts
import { randomBytes } from "crypto";
import { join } from "path";
function enqueueJob(jobData, jobType) {
  const jobId = randomBytes(8).toString("hex");
  const queueDir = join(statePath("queue"));
  const jobPath = join(queueDir, `${jobId}.json`);
  mkdir(queueDir);
  const payload = { ...jobData };
  if (jobType !== void 0) {
    payload._jobType = jobType;
  }
  const contents = JSON.stringify(payload, null, 2);
  try {
    atomicWrite(jobPath, contents);
    return jobId;
  } catch (err) {
    logError({
      code: "E_QUEUE_CLAIM",
      kind: "informational",
      what: err instanceof Error ? err.message : String(err),
      consequence: "Job was not enqueued"
    });
    return null;
  }
}
function claimJob(jobType) {
  const queueDir = join(statePath("queue"));
  const claimedDir = join(queueDir, "claimed");
  const failedDir = join(queueDir, "failed");
  if (!pathExists(queueDir)) {
    return null;
  }
  let jobs;
  try {
    jobs = listDir(queueDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (jobs.length === 0) {
    return null;
  }
  const claimedFiles = pathExists(claimedDir) ? listDir(claimedDir) : [];
  for (const jobFile of jobs) {
    const jobPath = join(queueDir, jobFile);
    const jobId = jobFile.replace(".json", "");
    let jobData;
    try {
      const contents = readFile(jobPath);
      const parsed = JSON.parse(contents);
      jobData = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      continue;
    }
    if (jobType !== void 0) {
      const payloadType = jobData._jobType;
      if (payloadType !== jobType) {
        continue;
      }
    }
    const jobClaims = claimedFiles.filter((f) => f.startsWith(jobId + "."));
    jobClaims.forEach((claim) => {
      const claimPath = join(claimedDir, claim);
      try {
        const s = stat(claimPath);
        if (!s) return;
        const mtime = typeof s.mtimeMs === "number" ? s.mtimeMs : 0;
        const age = Date.now() - mtime;
        if (age > QUEUE_STALE_MS) {
          remove(claimPath);
        }
      } catch {
      }
    });
    const currentClaimCount = jobClaims.length;
    if (currentClaimCount >= QUEUE_CLAIM_ATTEMPTS) {
      mkdir(failedDir);
      try {
        rename(jobPath, join(failedDir, jobId + ".json"));
      } catch {
      }
      continue;
    }
    mkdir(claimedDir);
    const claimedPath = join(claimedDir, `${jobId}.${String(process.pid)}.json`);
    try {
      rename(jobPath, claimedPath);
      return { id: jobId, data: jobData };
    } catch {
      continue;
    }
  }
  return null;
}
function completeJob(jobId) {
  const claimedDir = join(statePath("queue"), "claimed");
  if (!pathExists(claimedDir)) return;
  for (const file of listDir(claimedDir)) {
    if (!file.startsWith(jobId + ".")) continue;
    try {
      remove(join(claimedDir, file));
    } catch {
    }
  }
}

export {
  enqueueJob,
  claimJob,
  completeJob
};
