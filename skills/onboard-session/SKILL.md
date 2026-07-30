---
name: onboard-session
description: Seed mehmory for the current project from scratch — survey the repo (README, package manifest, git log, docs), then write project.md, a first set of pages and the index under ~/.mehmory, and commit. Use on a fresh store, when SessionStart says the store was just created, or when the user asks to onboard, bootstrap, or set up memory for this project. Writes to ~/.mehmory (outside the project), so Claude Code may prompt for permission.
allowed-tools: Read, Write, Bash, Glob, Grep
---

# Onboard session

In-session onboarding: build the initial wiki for **this** project from what the repo
already tells you. This is not transcript mining — it reads the codebase, not history.

## 1. Check what exists

```bash
HOME_DIR="${MEHMORY_HOME:-$HOME/.mehmory}"
ls "$HOME_DIR" && cat "$HOME_DIR/SCHEMA.md"
```

The store is created automatically by the SessionStart hook, so it should already be
there. Get the project key from the newest session-state file
(`grep -l '"session_id"' "$HOME_DIR"/.state/*.json | xargs -r ls -t | head -1`); the
scope root is `$HOME_DIR/projects/<key>/`. If that directory has a non-trivial
`index.md` already, stop and tell the user — run `/mehmory:integrate` or
`/mehmory:lint` instead of re-seeding over existing memory.

Create the scope if it is missing:

```bash
mkdir -p "$HOME_DIR/projects/<key>/pages"
```

## 2. Survey the project

Read what is actually there, in roughly this order, and stop when you have enough:

- `README*`, `CONTRIBUTING*`, `AGENTS.md` / `CLAUDE.md`
- the package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …)
- `docs/**`, ADR directories, any `*.md` at the repo root
- `git log --oneline -30` and `git log --format='%an' | sort | uniq -c | sort -rn | head`
- the top-level directory layout

You are looking for durable facts: what this project is, its stack, how it is built,
tested and deployed, the conventions it enforces, and the decisions that would surprise
a newcomer. Skip anything a fresh `ls` would tell you anyway.

## 3. Write `project.md`

`$HOME_DIR/projects/<key>/project.md`, at most ~200 tokens, telegraphic bullets:
what the project is, the stack, current state, and current focus. Mark the current-focus
line as ephemeral so every later integrate refreshes or deletes it:

```
---
updated: YYYY-MM-DD
type: entity
decay: ephemeral
---
```

(Use `decay: ephemeral` only on genuinely in-flux content; the rest of `project.md` can
be a separate stable section or a linked page.)

## 4. Seed the first pages

Three to seven pages, no more. Each one is a topic, not a file dump: build/test/deploy
procedure, notable decisions with their rationale, gotchas that cost someone an hour,
key entities (services, databases, external APIs). One page per topic under
`pages/<slug>.md`, each with frontmatter (`updated`, `type`, optional `refs` naming the
file you learned it from, e.g. `refs: README.md`).

Facts about the *user* rather than the project — editor, tooling, style preferences —
go in `$HOME_DIR/global/identity.md`, not here.

## 5. Write the index

`$HOME_DIR/projects/<key>/index.md`, one line per page, exactly this format:

```
- [[deploy-process]] — staging via GitHub Actions, prod is manual
```

The `[[slug]]` is how the tooling associates the line with its page — keep it exact.
Keep the whole index under ~500 tokens.

## 6. Log and commit

Append to `$HOME_DIR/projects/<key>/log.md`:

```
## [YYYY-MM-DD] onboard | seeded project.md + <n> pages
```

```bash
git -C "$HOME_DIR" add -A && git -C "$HOME_DIR" commit -m "onboard: seed <key> with <n> pages"
```

Then show the user the index you wrote and tell them memory is live: it will grow on its
own from here, and `/mehmory:integrate` files whatever the hooks capture.
