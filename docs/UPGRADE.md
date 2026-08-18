# Upgrading

mehmory has two version numbers, and they mean different things:

- **`FORMAT_VERSION`** (in `src/schema/format.ts`) — the machine-parsed format version. This
  is what code checks when it decides how to parse a file. It bumps on code-only changes and
  is not something you, as a user, take action on.
- **`schema_version`** (in your store's `SCHEMA.md`, at `~/.mehmory/SCHEMA.md` or
  `$MEHMORY_HOME/SCHEMA.md`) — the editorial template version. `SCHEMA.md` is copied into
  your store at `init` time and is yours thereafter (your edits win over the plugin's
  template — this is deliberate co-evolution, not a bug). `schema_version` is how mehmory
  tells you your copy has fallen behind the plugin's current template.

## What `doctor` checks

`mehmory doctor` reads `schema_version` out of your store's `SCHEMA.md` and compares it
against the version baked into the current plugin build. This is a narrow, read-only
exception to the rule that `SCHEMA.md` is never machine-parsed — the comparison touches
exactly that one frontmatter-like value and nothing else in the file.

- If your `schema_version` matches, `doctor` reports it `ok`.
- If it's behind, `doctor` reports a `warn` finding naming both versions.

This check is against `schema_version`, not `FORMAT_VERSION` — `FORMAT_VERSION` changes on
code-only bumps that carry no correct user action, and warning on every one of those would
train you to ignore the warning entirely by the time a real template drift shows up.

## What to do about drift

`doctor`'s drift warning doesn't auto-migrate anything. When you see it:

1. Read what changed between the two `schema_version`s (the plugin's changelog / release
   notes for the version you've updated to).
2. Decide, page by page, whether your existing `SCHEMA.md` customizations still apply or
   whether you want to adopt the new template's conventions.
3. Edit `~/.mehmory/SCHEMA.md` (or `$MEHMORY_HOME/SCHEMA.md`) by hand to pick up whichever
   parts of the new template you want. Nothing forces a wholesale copy-over — the whole point
   of `SCHEMA.md` being user-owned is that your edits survive a plugin upgrade.

There is no automatic migration step in v1. `doctor`'s warning is the entire upgrade signal
you get; treat it as a nudge to go read the diff, not as an error that needs suppressing.

## `FORMAT_VERSION` history

- **3** — inbox entries carry an optional `agent=` field recording which named agent
  captured them, immediately after `host=` in the trailing comment. Entries from unnamed
  agents omit it, as do all entries already in your store from before this change; those
  are **not** rewritten, the parser still reads them, and they stay unattributed — an
  entry with no agent is never routed into an agent scope. A value that fails agent-name
  validation is dropped at parse time and the entry survives without attribution. No
  action needed when upgrading.

  **Downgrading is not symmetric.** An older build's parser requires `ts=` to follow
  `host=` directly, so a line carrying `agent=` fails to match *entirely* — the whole
  entry, not just the new field. Under an older build such an entry is invisible: it is
  never integrated, never cleared, and not reachable by `purge --session`; because
  deduplication only sees ids the running parser can read, a replayed capture can append a
  second copy of the same fact. If you need to roll back, run `/mehmory:integrate` first so
  nothing is left un-integrated in an inbox. This applies to a store shared across machines
  or synced by git, where one side can lag the other.
- **2** (issue #20) — inbox entries carry a `host=` field recording which harness
  captured them (`claude-code` or `codex`), between `src=` and `ts=` in the trailing
  comment. Entries already in your store from before this change have no `host=`
  field; they are **not** rewritten, and the parser still reads them, attributing them
  to `claude-code`. No action needed.
- **1** — initial single-line inbox entry format (A14).
