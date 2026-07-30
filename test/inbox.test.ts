import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  INBOX_ENTRY_PATTERN,
  inboxEntryId,
  parseInboxEntries,
  serializeInboxEntry,
  type InboxEntry,
} from '../src/schema/format.js';
import {
  appendInboxEntries,
  clearInboxEntries,
  readInboxEntries,
  snapshotClearInbox,
} from '../src/core/inbox.js';
import { atomicWrite, readFile } from '../src/core/fs.js';
import { mehmoryHome } from '../src/core/home.js';

const KEY = 'github.com/acme/repo';

function inboxFile(name = 'inbox.md'): string {
  return join(mehmoryHome(), 'projects', 'acme', name);
}

function entry(text: string, seed: string, src = 'session-a'): InboxEntry {
  return { id: inboxEntryId(seed), text, src, ts: '2026-07-29T12:00:00.000Z' };
}

describe('inbox entry format (A14)', () => {
  it('round-trips a plain entry', () => {
    const original = entry('use postgres for the ledger', 'seed-1');
    const line = serializeInboxEntry(original);

    expect(line).toMatch(INBOX_ENTRY_PATTERN);
    expect(parseInboxEntries(line)).toEqual([original]);
  });

  it('round-trips embedded newlines as a single line', () => {
    const original = entry('first line\nsecond line', 'seed-2');
    const line = serializeInboxEntry(original);

    expect(line.includes('\n')).toBe(false);
    expect(parseInboxEntries(line)[0]?.text).toBe('first line\nsecond line');
  });

  it('neutralizes a comment terminator in the text', () => {
    const line = serializeInboxEntry(entry('watch out for --> arrows', 'seed-3'));

    expect(line).toMatch(INBOX_ENTRY_PATTERN);
    expect(parseInboxEntries(line)[0]?.text).toBe('watch out for --> arrows');
  });

  it('ignores non-entry lines so the inbox stays human-editable', () => {
    const content = [
      '---',
      'updated: 2026-07-29',
      '---',
      '',
      '# Inbox',
      '',
      '- a hand-written bullet with no trailer',
      serializeInboxEntry(entry('machine entry', 'seed-4')),
      '',
    ].join('\n');

    const parsed = parseInboxEntries(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.text).toBe('machine entry');
  });

  it('derives a 16-hex-char id deterministically', () => {
    expect(inboxEntryId('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(inboxEntryId('abc')).toBe(inboxEntryId('abc'));
    expect(inboxEntryId('abc')).not.toBe(inboxEntryId('abd'));
  });
});

describe('appendInboxEntries', () => {
  it('appends entries to a fresh file', () => {
    const path = inboxFile();
    const result = appendInboxEntries(path, [entry('one', 's1'), entry('two', 's2')], KEY);

    expect(result).toEqual({ appended: 2, skipped: 0 });
    expect(readInboxEntries(path).map(e => e.text)).toEqual(['one', 'two']);
  });

  it('is a no-op for ids already in the file (replay)', () => {
    const path = inboxFile('replay.md');
    const entries = [entry('one', 's1'), entry('two', 's2')];

    appendInboxEntries(path, entries, KEY);
    const second = appendInboxEntries(path, entries, KEY);

    expect(second).toEqual({ appended: 0, skipped: 2 });
    expect(readInboxEntries(path)).toHaveLength(2);
  });

  it('appends only the new entries of a partially-seen batch', () => {
    const path = inboxFile('partial.md');
    appendInboxEntries(path, [entry('one', 's1')], KEY);

    const result = appendInboxEntries(path, [entry('one', 's1'), entry('three', 's3')], KEY);

    expect(result).toEqual({ appended: 1, skipped: 1 });
    expect(readInboxEntries(path).map(e => e.text)).toEqual(['one', 'three']);
  });

  it('preserves the file preamble', () => {
    const path = inboxFile('preamble.md');
    atomicWrite(path, '---\nupdated: 2026-07-29\n---\n\n# Inbox\n\n');

    appendInboxEntries(path, [entry('one', 's1')], KEY);

    expect(readFile(path)).toContain('# Inbox');
    expect(readInboxEntries(path)).toHaveLength(1);
  });
});

describe('snapshot / clear (A15)', () => {
  it('removes exactly the snapshotted entries', () => {
    const path = inboxFile('clear.md');
    appendInboxEntries(path, [entry('one', 's1'), entry('two', 's2')], KEY);

    const snapshot = snapshotClearInbox(path, KEY);

    expect(snapshot.map(e => e.text)).toEqual(['one', 'two']);
    expect(readInboxEntries(path)).toHaveLength(0);
  });

  it('keeps an entry appended between the snapshot and the clear', () => {
    const path = inboxFile('race.md');
    appendInboxEntries(path, [entry('captured before', 's1')], KEY);

    // Integrate snapshots the inbox...
    const snapshot = readInboxEntries(path);
    expect(snapshot).toHaveLength(1);

    // ...a Stop hook captures while the model is still editing pages...
    appendInboxEntries(path, [entry('captured during integrate', 's2')], KEY);

    // ...and only then does integrate clear what it actually took.
    const cleared = clearInboxEntries(
      path,
      KEY,
      snapshot.map(e => e.id)
    );

    expect(cleared.removed).toBe(1);
    const remaining = readInboxEntries(path);
    expect(remaining.map(e => e.text)).toEqual(['captured during integrate']);
  });

  it('preserves non-entry lines when clearing', () => {
    const path = inboxFile('preserve.md');
    atomicWrite(path, '---\nupdated: 2026-07-29\n---\n\n# Inbox\n\n');
    appendInboxEntries(path, [entry('one', 's1')], KEY);

    snapshotClearInbox(path, KEY);

    expect(readFile(path)).toContain('# Inbox');
    expect(readInboxEntries(path)).toHaveLength(0);
  });

  it('clearing an empty id list is a no-op', () => {
    const path = inboxFile('noop.md');
    appendInboxEntries(path, [entry('one', 's1')], KEY);

    expect(clearInboxEntries(path, KEY, []).removed).toBe(0);
    expect(readInboxEntries(path)).toHaveLength(1);
  });

  it('reading a missing inbox yields no entries', () => {
    expect(readInboxEntries(inboxFile('absent.md'))).toEqual([]);
  });
});
