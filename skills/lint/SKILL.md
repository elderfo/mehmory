---
name: lint
description: Full-sweep health check of the mehmory wiki under ~/.mehmory — staleness, orphan pages, contradictions across pages, and archive candidates. Reports everything first and applies only the fixes the user approves. Use when the user asks to lint, audit, clean up, or check memory. Writes to ~/.mehmory (outside the project), so Claude Code may prompt for permission on the apply step; the report itself is read-only.
allowed-tools: Read Edit Bash Glob Grep
---

# Lint

`integrate` fixes what it happens to touch. `lint` is the full pass over everything, and
it never edits before the user says so.

## 1. Locate the scope

```bash
HOME_DIR="${MEHMORY_HOME:-$HOME/.mehmory}"
```

Read the project key from the newest session-state file
(`grep -l '"session_id"' "$HOME_DIR"/.state/*.json | xargs -r ls -t | head -1`), or ask
the user which of `$HOME_DIR/projects/*` to sweep. Lint one scope at a time; `global/`
is a valid scope. Read `$HOME_DIR/SCHEMA.md` first — the user's conventions govern.

## 2. Sweep — report only, change nothing yet

Collect findings in these four categories:

- **Staleness** — pages whose claims read as no longer true, judged against the codebase
  and the frontmatter `updated` date. A date alone is not staleness; an evergreen page
  can be years old and correct. Say what specifically looks wrong.
- **Orphans** — pages with no inbound `[[slug]]` link anywhere in the scope *and* no
  line in `index.md`. Derive both by grep; nothing is stored.
  ```bash
  grep -ro '\[\[[^]]*\]\]' "<scope>" | sort -u
  ```
- **Contradictions** — two pages (or two lines) asserting incompatible things. Quote
  both sides with their file paths. This is the finding class the user most wants.
- **Archive candidates** — `decay: default` pages that are genuinely finished business,
  plus index lines pointing at pages that no longer exist and pages missing from the
  index.

Also flag pages over their size cap (~1500 tokens; `index.md` ~500;
`identity.md`/`project.md` ~200) as split candidates.

## 3. Report

Present the findings grouped by category, each with the file path and a one-line
proposed fix. Number them so the user can approve a subset. Then stop and ask.

## 4. Apply only what was approved

Apply exactly the approved items — no adjacent tidying. Rules that still bind:

- Supersession is editing: rewrite the wrong line rather than appending a correction.
- Archiving a page moves the file into `<scope>/archive/` and **removes its line from
  `index.md`** — archived pages are still greppable, but they are out of the catalog.
- Index lines keep the exact format `- [[slug]] — one-line summary`.
- Bump `updated` in the frontmatter of every page you edit.
- Nothing is ever deleted outright; archive plus git history is how decay works.

## 5. Log, commit, record

```bash
git -C "$HOME_DIR" add -A && git -C "$HOME_DIR" commit -m "lint: <n> findings, <m> applied"
```

Append the log line to the scope's `log.md`
(`## [YYYY-MM-DD] lint | <n> findings, <m> applied`) and one instrumentation line to
`$HOME_DIR/.state/stats.jsonl`:

```bash
printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"project\":\"<key>\",\"hook\":\"lint\",\"ms\":<elapsed>,\"entries_integrated\":0,\"pages_touched\":<m>}" \
  >> "$HOME_DIR/.state/stats.jsonl"
```

If the user approved nothing, skip the commit and still write the stats line with
`"pages_touched":0` — a sweep that found nothing is a measurement worth keeping.
