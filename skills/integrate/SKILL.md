---
name: integrate
description: Merge captured mehmory inbox entries into the wiki pages under ~/.mehmory — editing pages, links, index lines and frontmatter, then clearing the inbox transactionally and committing. Use when the SessionStart nudge says the inbox is over threshold, or whenever the user asks to integrate, process, or file memory. Writes to ~/.mehmory (outside the project), so Claude Code may prompt for permission; if writes are denied nothing is lost — entries stay in the inbox for the next pass.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Integrate

Turn raw inbox entries into the wiki. This is editorial work: you decide where a fact
belongs, whether it supersedes something already written, and how to say it in one line.
The only mechanical step — clearing the inbox — goes through a helper, never through Edit.

## 1. Locate the store and the project

```bash
HOME_DIR="${MEHMORY_HOME:-$HOME/.mehmory}"
ls "$HOME_DIR"
```

If `mehmory` is not on PATH, install it before doing anything else
(`npm install -g mehmory`). **Do not proceed without it** — clearing the inbox
by hand loses entries captured mid-integrate.

The project key is cached by the hooks in the newest session-state file:

```bash
grep -l '"session_id"' "$HOME_DIR"/.state/*.json 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | head -1 | xargs -r cat
```

Read `project_key` from it. If it is absent, `ls "$HOME_DIR/projects"` and ask the user
which project this session belongs to. The scope root is then
`$HOME_DIR/projects/<key>/`; user-level facts (preferences, tooling, style) belong in
`$HOME_DIR/global/` instead — use that scope's `inbox.md`, `index.md` and `pages/`.

## 2. Read before you write

Read, in this order: `$HOME_DIR/SCHEMA.md` (the user's conventions win over anything in
this file), the scope's `index.md`, and the scope's `inbox.md`.

## 3. Snapshot the inbox

```bash
echo '{"inbox":"<scope>/inbox.md","key":"<project key>"}' | mehmory inbox-tx snapshot
```

Stdout is `{"snapshotId": "...", "entries": [{"id","text","src","ts"}, ...]}`. Keep the
`snapshotId`. Integrate **only** the entries in this snapshot — anything captured while
you work stays in the inbox for the next pass. Non-zero exit means stop: report the
stderr line to the user and change nothing.

## 4. Merge each entry into a page

For every snapshot entry:

- **Existing topic** — open the page and edit it. Supersession is editing: when a new
  fact contradicts a line, **rewrite that line**, do not append a second contradicting
  bullet and do not annotate the old one as outdated. Git history is the audit trail.
- **New topic** — create `pages/<slug>.md` with frontmatter (`updated`, `type` from
  decision|procedure|entity|preference|gotcha, optional `refs`, optional `decay`).
- **House style** — short telegraphic bullets, one fact per line; full prose only where
  the nuance genuinely needs it. Split a page over ~1500 tokens rather than growing it.
- **Provenance** — carry the entry's `src` into the page's `refs` frontmatter as
  `session:<src>`, keeping existing refs. That is how a claim is traced back later.
- **Links** — add `[[slug]]` wikilinks to related pages when the connection is real.
  Backlinks are derived by grep, never stored.
- **Frontmatter `updated`** — set to today's date on every page you touch.

## 5. Refresh or delete ephemeral content

Every integrate pass, without exception and with no age threshold: for each page marked
`decay: ephemeral` and for each ephemeral field elsewhere (`current focus` in
`project.md` is the common one), either restate it from this pass's evidence or delete
it. An ephemeral line you cannot confirm is stale by definition — delete it. Archived
history is in git; nothing is truly lost.

## 6. Update the index

Each page gets exactly one line in the scope's `index.md`:

```
- [[slug]] — one-line summary
```

The `[[slug]]` is how tooling associates an index line with its page, so keep the format
exact. Add lines for new pages, rewrite summaries you invalidated, and keep the index
under ~500 tokens. Lines below the `## Archive` divider are demoted pages left there by
the mechanical decay pass — leave them where they are.

## 7. Clear the inbox transactionally

```bash
echo '{"inbox":"<scope>/inbox.md","key":"<key>","snapshotId":"<id>"}' | mehmory inbox-tx clear
```

This removes exactly the snapshotted entries and leaves later ones alone. Clear only
after the pages are written: if you stop before this step the inbox is intact and the
work simply repeats.

## 8. Log, commit, record

Append one line to the scope's `log.md`:

```
## [YYYY-MM-DD] integrate | <n> entries → <m> pages
```

Commit the store:

```bash
git -C "$HOME_DIR" add -A && git -C "$HOME_DIR" commit -m "integrate: <n> entries, <m> pages"
```

Then append one instrumentation line to `$HOME_DIR/.state/stats.jsonl` — one JSON object
on one line, same shape the hooks write:

```bash
printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"project\":\"<key>\",\"hook\":\"integrate\",\"ms\":<elapsed>,\"entries_integrated\":<n>,\"pages_touched\":<m>}" \
  >> "$HOME_DIR/.state/stats.jsonl"
```

Finally tell the user, in one line, how many entries landed in which pages.
