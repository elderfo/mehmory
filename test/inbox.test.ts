import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INBOX_ENTRY_PATTERN,
  inboxEntryId,
  parseInboxEntries,
  serializeInboxEntry,
  type InboxEntry,
  type InboxHost,
} from '../src/schema/format.js';
import {
  appendInboxEntries,
  clearInboxEntries,
  readInboxEntries,
  snapshotClearInbox,
} from '../src/core/inbox.js';
import { atomicWrite, readFile } from '../src/core/fs.js';
import { mehmoryHome } from '../src/core/home.js';
import {
  applyDistillJob,
  distillDelta,
  distillJobPayload,
  rememberEntry,
  scopePaths,
} from '../src/core/capture.js';
import { loadConfig, type MehmoryConfig } from '../src/core/config.js';
import { isSafeAgentName } from '../src/core/agent.js';

const KEY = 'github.com/acme/repo';

function inboxFile(name = 'inbox.md'): string {
  return join(mehmoryHome(), 'projects', 'acme', name);
}

function entry(
  text: string,
  seed: string,
  src = 'session-a',
  host: InboxHost = 'claude-code'
): InboxEntry {
  return { id: inboxEntryId(seed), text, src, host, ts: '2026-07-29T12:00:00.000Z' };
}

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inbox');

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

  it('neutralizes the `--!>` comment terminator too, not just `-->`', () => {
    // HTML closes a comment on `--!>` as well as `-->`. Escaping only the latter left a
    // second terminator live in text mehmory writes into a markdown file, which is what
    // CodeQL's js/bad-tag-filter flags. Round-tripping is the binding half: neutralizing
    // by dropping characters would silently corrupt the user's own words.
    const line = serializeInboxEntry(entry('watch out for --!> arrows', 'seed-bang'));

    expect(line).toMatch(INBOX_ENTRY_PATTERN);
    expect(line.slice(0, line.indexOf(' <!--mehmory'))).not.toContain('--!>');
    expect(parseInboxEntries(line)[0]?.text).toBe('watch out for --!> arrows');
  });

  it('round-trips text carrying both terminator spellings at once', () => {
    const text = 'a --> b --!> c';
    const line = serializeInboxEntry(entry(text, 'seed-both'));

    expect(line).toMatch(INBOX_ENTRY_PATTERN);
    expect(parseInboxEntries(line)[0]?.text).toBe(text);
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

describe('inbox entry host (issue #20, FORMAT_VERSION 2)', () => {
  it('round-trips a codex-captured entry', () => {
    const original = entry('captured via codex', 'seed-codex', 'session-a', 'codex');
    const line = serializeInboxEntry(original);

    expect(line).toContain('host=codex');
    expect(parseInboxEntries(line)).toEqual([original]);
  });

  it('defaults an entry with no host to claude-code on serialize', () => {
    const noHost: InboxEntry = {
      id: inboxEntryId('seed-nohost'),
      text: 'no host supplied',
      src: 'session-a',
      ts: '2026-07-29T12:00:00.000Z',
    };
    const line = serializeInboxEntry(noHost);

    expect(line).toContain('host=claude-code');
    expect(parseInboxEntries(line)[0]?.host).toBe('claude-code');
  });

  it('parses a FORMAT_VERSION 1 fixture line (no host=) and attributes it to claude-code', () => {
    const content = readFile(join(fixtureDir, 'previous-format.md'));
    const parsed = parseInboxEntries(content);

    expect(parsed).toEqual([
      {
        id: '00000000000000a1',
        text: 'staging deploys need the VPN',
        src: 'session-old',
        host: 'claude-code',
        ts: '2026-06-01T09:00:00.000Z',
      },
      {
        id: '00000000000000a2',
        text: 'use postgres for the ledger',
        src: 'session-old',
        host: 'claude-code',
        ts: '2026-06-01T09:05:00.000Z',
      },
    ]);
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

describe('inbox entry agent (R7, KTD5, FORMAT_VERSION 3)', () => {
  const named: InboxEntry = {
    id: inboxEntryId('seed-agent'),
    text: 'scout prefers terse reports',
    src: 'session-a',
    host: 'claude-code',
    agent: 'scout',
    ts: '2026-08-15T12:00:00.000Z',
  };

  /** The same entry, with `agent=` replaced by `value` in the serialized line. */
  function withAgentValue(value: string): string {
    return serializeInboxEntry(named).replace('agent=scout', `agent=${value}`);
  }

  it('round-trips an agent-stamped entry', () => {
    const line = serializeInboxEntry(named);

    expect(line).toContain('agent=scout');
    expect(line).toMatch(INBOX_ENTRY_PATTERN);
    expect(parseInboxEntries(line)).toEqual([named]);
  });

  it('omits the agent segment entirely when there is no name', () => {
    const line = serializeInboxEntry(entry('unnamed capture', 'seed-unnamed'));

    expect(line).not.toContain('agent=');
    expect(line).toMatch(INBOX_ENTRY_PATTERN);
    expect(parseInboxEntries(line)[0]?.agent).toBeUndefined();
  });

  it('parses a FORMAT_VERSION 2 fixture line (host=, no agent=) with its host intact', () => {
    const parsed = parseInboxEntries(readFile(join(fixtureDir, 'previous-format-v2.md')));

    expect(parsed).toEqual([
      {
        id: '00000000000000b1',
        text: 'staging deploys need the VPN',
        src: 'session-v2',
        host: 'codex',
        ts: '2026-07-01T09:00:00.000Z',
      },
      {
        id: '00000000000000b2',
        text: 'use postgres for the ledger',
        src: 'session-v2',
        host: 'claude-code',
        ts: '2026-07-01T09:05:00.000Z',
      },
    ]);
  });

  it('refuses to write an unsafe agent value at all', () => {
    // The write boundary, not only the read one: `applyDistillJob` rehydrates entries
    // from a JSON payload on disk, so an unsafe value must never reach the file.
    const line = serializeInboxEntry({ ...named, agent: '../../global' });

    expect(line).not.toContain('agent=');
    expect(line).toMatch(INBOX_ENTRY_PATTERN);
  });

  it('keeps an entry whose agent= was hand-edited to nothing', () => {
    // The inbox is a file people edit. A `\S+` value group would fail the whole line on
    // this typo, losing the entry rather than just its attribution — the same silent
    // whole-entry drop a stricter trailer causes across versions.
    const parsed = parseInboxEntries(withAgentValue(''));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.agent).toBeUndefined();
    expect(parsed[0]?.text).toBe(named.text);
    expect(parsed[0]?.host).toBe('claude-code');
  });

  it('drops a traversal agent value but keeps the entry', () => {
    // The inbox is a human-editable file every agent in a repo writes to, and the value
    // read back out of it reaches a routing decision that composes a filesystem path.
    const parsed = parseInboxEntries(withAgentValue('../../global'));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.agent).toBeUndefined();
    expect(parsed[0]?.text).toBe(named.text);
  });

  it('drops a mixed-case or over-length agent value but keeps the entry', () => {
    for (const hostile of ['Scout', 'a'.repeat(65), '.git', 'global']) {
      const parsed = parseInboxEntries(withAgentValue(hostile));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.agent).toBeUndefined();
    }
  });
});

describe('the golden inbox integration reads (R8, KTD7)', () => {
  // The routing decision itself is judgment: `/mehmory:integrate` reads the rule out of
  // skills/integrate/SKILL.md and applies it. What is mechanical — and what would rot
  // without notice — is the substrate that decision stands on: whether an inbox holding
  // every class of entry hands integration an unambiguous destination for each line.
  it('presents each of the four entry classes unambiguously', () => {
    const at = (n: number): string => `2026-08-15T12:0${String(n)}:00.000Z`;
    const lines = [
      `- scout prefers terse reports <!--mehmory id=${inboxEntryId('g1')} src=s host=claude-code agent=scout ts=${at(1)}-->`,
      `- probe checks the slow paths first <!--mehmory id=${inboxEntryId('g2')} src=s host=claude-code agent=probe ts=${at(2)}-->`,
      `- the build runs pnpm build <!--mehmory id=${inboxEntryId('g3')} src=s host=claude-code ts=${at(3)}-->`,
      // The case that decides whether the routing rule is read correctly: a repo fact
      // that carries a stamp, because every entry a named agent captures carries one.
      // It must reach integration stamped, so the rule can route it on subject and send
      // it to the project scope rather than into scout's private one.
      `- the slow suite is cli-purge <!--mehmory id=${inboxEntryId('g5')} src=s host=claude-code agent=scout ts=${at(5)}-->`,
      `- a hand-edited line with a hostile stamp <!--mehmory id=${inboxEntryId('g4')} src=s host=claude-code agent=../../global ts=${at(4)}-->`,
    ];
    atomicWrite(inboxFile(), `${lines.join('\n')}\n`);

    const snapshot = snapshotClearInbox(inboxFile(), KEY);

    expect(snapshot).toHaveLength(5);
    expect(snapshot.map(e => e.agent)).toEqual(['scout', 'probe', undefined, 'scout', undefined]);
    // The two unattributed classes are indistinguishable on purpose: an entry that never
    // carried a name and one whose name was refused both reach integration with nothing
    // to route on, so neither can reach an agent scope (R8).
    expect(snapshot.filter(e => e.agent === undefined)).toHaveLength(2);
    // A stamp is not a subject. Two entries carry scout's name; only one is about scout.
    expect(snapshot.filter(e => e.agent === 'scout')).toHaveLength(2);
    // Nothing survives that could compose a path outside agents/.
    for (const e of snapshot) {
      expect(e.agent === undefined || isSafeAgentName(e.agent)).toBe(true);
    }
  });
});

describe('agent attribution across the deferred-capture queue (R7)', () => {
  // SessionEnd distills but defers the write, so entries round-trip through a JSON job
  // file before they reach an inbox. `applyDistillJob` rebuilds each entry field by
  // field rather than spreading it, so any field it does not name is silently dropped —
  // the same shape as the issue-#20 `host` bug. Without these, a deferred capture would
  // land unattributed and nothing would fail.
  const config: MehmoryConfig = loadConfig();

  it('carries the agent across the queue payload', () => {
    const stamped: InboxEntry = {
      id: inboxEntryId('queued-agent'),
      text: 'scout learned the release ritual',
      src: 'session-deferred',
      host: 'claude-code',
      agent: 'scout',
      ts: '2026-08-15T12:00:00.000Z',
    };
    const payload = JSON.parse(JSON.stringify(distillJobPayload(KEY, [stamped]))) as Record<
      string,
      unknown
    >;

    expect(applyDistillJob(payload, config)).toBe(1);
    expect(readInboxEntries(scopePaths(KEY).inboxFile)[0]?.agent).toBe('scout');
  });

  it('drops an unsafe agent from the queue payload but keeps the entry', () => {
    // The job file on disk is a read boundary exactly like the inbox (KTD5).
    const payload = {
      key: KEY,
      entries: [
        {
          id: inboxEntryId('queued-traversal'),
          text: 'a deferred capture with a hostile stamp',
          src: 'session-deferred',
          host: 'claude-code',
          agent: '../../global',
          ts: '2026-08-15T12:00:00.000Z',
        },
      ],
    };

    expect(applyDistillJob(payload, config)).toBe(1);
    const written = readInboxEntries(scopePaths(KEY).inboxFile);
    expect(written).toHaveLength(1);
    expect(written[0]?.agent).toBeUndefined();
  });
});

describe('agent attribution on capture (R7)', () => {
  const transcript = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'transcripts',
    'claude-code-shape.jsonl'
  );

  /** A config whose machine-wide default agent name is `value` (empty means unnamed). */
  function configWithAgent(value: string): MehmoryConfig {
    const base = loadConfig();
    return { ...base, identity: { ...base.identity, agent: value } };
  }

  afterEach(() => {
    delete process.env.MEHMORY_AGENT;
  });

  it('lets two named agents share one project scope, each entry keeping its own name', () => {
    // AE2 / KD4: the project scope is collaboration, not leakage. Two named agents in one
    // repo write the same inbox and each reads what the other put there — only the self
    // is separate. This is the half of the feature that is about *not* isolating things,
    // so it needs a test as much as the isolation does.
    const inbox = scopePaths(KEY).inboxFile;

    process.env.MEHMORY_AGENT = 'scout';
    const fromScout = rememberEntry('the release ritual is pnpm build then tag', 's1', 'claude-code', configWithAgent(''));
    process.env.MEHMORY_AGENT = 'probe';
    const fromProbe = rememberEntry('the slow test is cli-purge', 's2', 'claude-code', configWithAgent(''));

    appendInboxEntries(inbox, [fromScout, fromProbe], KEY);

    const shared = readInboxEntries(inbox);
    expect(shared).toHaveLength(2);
    expect(shared.map(e => e.agent)).toEqual(['scout', 'probe']);
    // One inbox, one project key — neither agent got a scope of its own to write into.
    expect(shared.every(e => e.text.length > 0)).toBe(true);
  });

  it('stamps the resolved name onto every entry distillDelta produces', () => {
    process.env.MEHMORY_AGENT = 'scout';

    const entries = distillDelta('session-distill', transcript, 'claude-code', configWithAgent(''));

    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every(e => e.agent === 'scout')).toBe(true);
  });

  it('leaves distillDelta entries unattributed when the agent is unnamed', () => {
    const entries = distillDelta(
      'session-distill-unnamed',
      transcript,
      'claude-code',
      configWithAgent('')
    );

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.agent === undefined)).toBe(true);
  });

  it('stamps the resolved name on rememberEntry', () => {
    expect(rememberEntry('note this', 'session-a', 'claude-code', configWithAgent('scout')).agent)
      .toBe('scout');
  });

  it('refuses an unsafe declared name and captures unattributed', () => {
    process.env.MEHMORY_AGENT = '../../global';

    expect(
      rememberEntry('note this', 'session-a', 'claude-code', configWithAgent('')).agent
    ).toBeUndefined();
  });

  it('writes one stamped and one unstamped line for a named and an unnamed capture', () => {
    const path = inboxFile('agents.md');

    appendInboxEntries(
      path,
      [
        rememberEntry('from scout', 'session-a', 'claude-code', configWithAgent('scout')),
        rememberEntry('from nobody', 'session-b', 'claude-code', configWithAgent('')),
      ],
      KEY
    );

    const lines = readFile(path).split('\n').filter(l => l.includes('<!--mehmory'));
    expect(lines).toHaveLength(2);
    expect(lines.filter(l => l.includes('agent=scout'))).toHaveLength(1);
    expect(lines.filter(l => l.includes('agent='))).toHaveLength(1);
    expect(readInboxEntries(path).map(e => e.agent)).toEqual(['scout', undefined]);
  });
});
