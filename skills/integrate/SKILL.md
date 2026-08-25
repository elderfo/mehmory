---
name: integrate
description: Merge captured mehmory inbox entries into the wiki pages under ~/.mehmory — editing pages, links, index lines and frontmatter, then clearing the inbox transactionally and committing. Use when the SessionStart nudge says the inbox is over threshold, or whenever the user asks to integrate, process, or file memory. Writes to ~/.mehmory (outside the project), so Claude Code may prompt for permission; if writes are denied nothing is lost — entries stay in the inbox for the next pass.
allowed-tools: Read Write Edit Bash Glob Grep
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

If `mehmory` is not on PATH, stop and ask the user to install it explicitly before doing
anything else. **Do not install packages from this skill** — clearing the inbox by hand
loses entries captured mid-integrate.

The project key is cached by the hooks in the newest session-state file:

```bash
grep -l '"session_id"' "$HOME_DIR"/.state/*.json 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | head -1 | xargs -r cat
```

Read `project_key` from it. If it is absent, `ls "$HOME_DIR/projects"` and ask the user
which project this session belongs to. The scope root is then
`$HOME_DIR/projects/<key>/`; user-level facts (preferences, tooling, style) belong in
`$HOME_DIR/global/` instead — use that scope's `inbox.md`, `index.md` and `pages/`.

A named agent has a third scope, `$HOME_DIR/agents/<name>/`, holding what that agent is:
its own preferences, style and non-project knowledge. It has an `identity.md`, an
`index.md` and a `pages/` directory, but no inbox of its own — every entry lands in the
project inbox and is routed out of it by its stamp (step 4).

The agent scopes that exist are the subdirectories of `$HOME_DIR/agents/`. That directory
is missing until the first agent-scoped write, and missing or empty both mean the same
thing — no agent scopes yet — so neither is a failure or a reason to stop. Create
`agents/<name>/` on the first entry that routes there, giving it an `identity.md` and an
`index.md` like any other scope.

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

- **Scope — decide by subject first, then read the stamp.** Ask what the entry is *about*:
  repo facts (build steps, layout, this codebase's conventions) go to the project scope;
  facts about the human (preferences, tooling, style) go to `global/`; an agent's own
  self-facts (how it works, what it prefers, what it has learned about itself) go to
  `agents/<name>/`.

  Only when the subject is a self-fact does the stamp matter, and then it answers exactly
  one question: *whose* scope. The `agent=` value is set on **every** entry captured while
  that agent was running — the snapshot carries it as the entry's `agent` field, mirroring
  the entry line's `- <text> <!--mehmory id=... src=... host=...[ agent=<name>] ts=...-->`
  — so it means "scout was running", never "this is about scout". A repo fact stamped
  `agent=scout` is still a repo fact and goes to the project scope, exactly as an unstamped
  one would. Treating the stamp as the filing rule would move the shared project knowledge
  into one agent's private scope, which is the opposite of what these scopes are for.

  Two rules bound it. File a *self-fact* stamped `agent=scout` into `agents/scout/`
  whatever your own name is — attribution is the entry's, not yours. And never route an
  entry with **no** stamp into any agent scope; with no name it cannot be anyone's self, so
  it is a project or `global/` fact. A stamped name that fails validation is dropped when
  the entry is parsed, so it reaches you unattributed; treat it as unstamped rather than
  guessing at the name.
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
