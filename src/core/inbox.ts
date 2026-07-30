/**
 * Inbox read/write primitives (A14, A15).
 *
 * The inbox is a human-readable markdown file; entries are single lines carrying a
 * machine-readable trailer (see `src/schema/format.ts`). Every mutation here is either
 * an atomic single-line append or a locked rewrite — never a read-modify-write on the
 * append path, so a capture racing an integrate cannot lose an entry.
 *
 * Callers pass the inbox file path explicitly (global/inbox.md or
 * projects/<key>/inbox.md); this module has no opinion on scope.
 */

import { appendRecord, atomicWrite, pathExists, readFile } from './fs.js';
import { withProjectLock } from './lock.js';
import { failOpen } from './errors.js';
import {
  parseInboxEntries,
  serializeInboxEntry,
  type InboxEntry,
} from '../schema/format.js';

export type { InboxEntry };

/** Read and parse the entries currently in an inbox file. Missing file → []. */
export function readInboxEntries(inboxFile: string): InboxEntry[] {
  return failOpen(
    () => (pathExists(inboxFile) ? parseInboxEntries(readFile(inboxFile)) : []),
    [],
    'E_APPEND_FAILED'
  );
}

/**
 * Append entries whose id is not already in the file.
 *
 * Dedup by id-in-file makes cursor replay a no-op (spec gap 21: the window closes at
 * the next integrate, whose editorial merge absorbs anything re-introduced after a
 * clear). Each entry is one `appendRecord` call, i.e. one atomic O_APPEND write.
 *
 * @param inboxFile - Path to inbox.md
 * @param entries - Entries to append (already redacted by the caller)
 * @param key - Project key, used only for the large-record lock path in appendRecord
 */
export function appendInboxEntries(
  inboxFile: string,
  entries: readonly InboxEntry[],
  key: string
): { appended: number; skipped: number } {
  const existing = new Set(readInboxEntries(inboxFile).map(e => e.id));
  let appended = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (existing.has(entry.id)) {
      skipped++;
      continue;
    }
    const result = appendRecord(inboxFile, serializeInboxEntry(entry), key, withProjectLock);
    if (result.ok) {
      existing.add(entry.id);
      appended++;
    } else {
      skipped++;
    }
  }

  return { appended, skipped };
}

/**
 * Remove exactly the given entry ids from the inbox, under the project lock.
 *
 * Re-reads the file inside the lock and rewrites it without those lines, so an entry
 * appended after the snapshot (appends do not take the lock — they are atomic on their
 * own) survives the clear. Non-entry lines are preserved verbatim.
 */
export function clearInboxEntries(
  inboxFile: string,
  key: string,
  ids: readonly string[]
): { removed: number } {
  const doomed = new Set(ids);
  if (doomed.size === 0) return { removed: 0 };

  return withProjectLock(key, () =>
    failOpen(
      () => {
        if (!pathExists(inboxFile)) return { removed: 0 };
        const lines = readFile(inboxFile).split('\n');
        const kept: string[] = [];
        let removed = 0;
        for (const line of lines) {
          const [entry] = parseInboxEntries(line);
          if (entry && doomed.has(entry.id)) {
            removed++;
            continue;
          }
          kept.push(line);
        }
        if (removed > 0) atomicWrite(inboxFile, kept.join('\n'));
        return { removed };
      },
      { removed: 0 },
      'E_APPEND_FAILED'
    )
  );
}

/**
 * Snapshot the current entries and clear exactly those (integrate's transactional
 * step, A15). Returns the snapshot so the caller can integrate it; entries appended
 * between the snapshot and the clear are left in the inbox.
 *
 * Uses the full 50 × 100 ms lock retry (skill path — not the hook maintenance lane).
 */
export function snapshotClearInbox(inboxFile: string, key: string): InboxEntry[] {
  const snapshot = readInboxEntries(inboxFile);
  clearInboxEntries(
    inboxFile,
    key,
    snapshot.map(e => e.id)
  );
  return snapshot;
}
