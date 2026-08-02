# How it works

mehmory is three planes. Every design argument in the project is about keeping them apart.

## 1. Files — the store

`~/.mehmory` (or `$MEHMORY_HOME`) is a git repo holding markdown:

- **Pages** — the wiki proper. `identity.md`, `project.md`, and whatever topic pages
  integration decides to create, all following the conventions in `SCHEMA.md`.
- **`index.md`** — the map, injected at session start so the model knows what exists.
- **Inbox** — a single-line-per-entry file of captured-but-not-yet-filed facts.
- **Archive** — demoted pages. Aged memory is flagged and moved, never silently deleted.
- **The log** — what happened, when, appended atomically. (Machine state — cursors,
  `stats.jsonl` — lives beside the wiki in `.state/`, deliberately outside git.)

Projects are keyed by a normalized git-remote slug, so the same checkout on two machines is
the same project and two clones of different repos never collide.

Every mutation is an atomic write plus a git commit, taken under a project-level lock — a
lock that itself fails open, proceeding with a warning rather than blocking your session if
it can't be acquired. A crash mid-write leaves the previous state, not a half file.

## 2. Hooks — deterministic capture

Five hooks, bundled to plain `.mjs` and wired into both Claude Code and Codex CLI (Codex has
no `SessionEnd` event, so that one runs on Claude Code only — see below):

| Hook | Job | Claude Code | Codex CLI |
| --- | --- | --- | --- |
| `SessionStart` | Compose the injection frame — identity + project + index, inside the token budget | ✓ | ✓ |
| `UserPromptSubmit` | Point at pages relevant to what you just typed | ✓ | ✓ |
| `Stop` | Distill the turn into inbox entries once the capture threshold is crossed | ✓ | ✓ |
| `PreCompact` | Capture before the context window collapses | ✓ | ✓ (payload unverified) |
| `SessionEnd` | Distill the last delta, queue it durably for the next session, clean up | ✓ | — (no such event; see below) |

Codex has no session-end event, so a Codex session is finalized at the *next* session's start
instead of its own end — the deterministic capture is not late by more than one session, but
`mehmory status` won't show that last stretch until then. A per-harness `hosts.<host>.enabled`
config toggle lets you turn either side off independently.

Three properties matter more than what they do:

**No LLM calls.** Hooks are pattern work and file work. They cost no tokens and add no
latency you'd notice.

**Fail-open, always.** Every bound — timeouts, lock waits, parse failures — resolves to
"continue the session without mehmory." A memory layer is not allowed to be the reason your
editor stops.

**Thin adapters only.** A hook parses stdin, calls into `src/core`, and writes stdout. All
behavior lives in the core library, which is synchronous, ESM-only, never exits the process,
and never throws across its own boundary. The CLI is a second thin consumer of that same
core, not a second implementation of it.

## 3. Skills — where judgment lives

Deciding whether "we moved to Postgres" belongs on the architecture page or the deploy page
is reading comprehension, not string matching. So the model does it, through plugin skills:

- **`/mehmory:integrate`** — fold the inbox into the wiki and commit
- **`/mehmory:remember`** — file one fact right now
- **`/mehmory:onboard-session`** — seed a project with no transcript history
- **`/mehmory:lint`** — check pages against `SCHEMA.md`
- **`/mehmory:pause` / `/mehmory:resume`** — stop and restart capture

Skills never hand-edit the store's transactional surfaces. Mutations that must be atomic go
through a bundled helper (`inbox-tx`) so a model mid-edit can't leave the inbox torn.

## Retrieval, honestly

Search is **one scan** over pages, archive and the log. There is no index and there are no
embeddings. Matching is keyword scoring with snippets and a file cap.

That trade is deliberate: an index is state that can go stale, and a stale index is a bug you
find at the worst time. A scan is always correct and fast enough at this size.

The cost is real and it's measured, not asserted. `test/fixtures/golden-queries.json` holds a
miniature wiki plus the queries a person would actually type at it, and the test reports
Recall@1 and Recall@3 on every change to weighting, tokenizing, stopwords or scoring. Queries
that share no vocabulary with their target page are reported as a **separate paraphrase
split** — that number is the honest size of what keyword matching cannot do.

## The context budget

Two things load before you type anything, and both are capped by a test:

- the `SessionStart` injection frame — `injection.budget_tokens`, default 800
- the six skill `description` fields — ~650 tokens, capped at 800 combined / 160 each

Memory that quietly grows your always-on prompt is a regression. Raising a ceiling here is a
commit that argues for itself.

## Privacy and deletion

Secrets are redacted on the way into the store, with configurable patterns and a whitelist.
The filter's real limits are written down in [Privacy](https://github.com/elderfo/mehmory/blob/main/docs/PRIVACY.md)
rather than oversold.

Both apply identically regardless of which harness produced the content — there's one store,
not one per harness. `mehmory purge` deletes by page, session (its un-integrated captures),
project, or everything, and can export first. It
removes from the working tree and commits the removal — **it never rewrites your git
history**, because rewriting a user's history to hide a secret is a worse outcome than
telling them plainly that the old commit still has it.

## Read further

- [Architectural decisions (A1–A22)](https://github.com/elderfo/mehmory/blob/main/docs/WORLD_MODEL.md) — the reasoning, with the trade-offs stated
- [CLI reference](https://github.com/elderfo/mehmory/blob/main/docs/CLI.md)
- [Config](https://github.com/elderfo/mehmory/blob/main/docs/CONFIG.md) — every key, its real default, and which ones are wired up versus inert
- [Upgrading](https://github.com/elderfo/mehmory/blob/main/docs/UPGRADE.md) — what a `schema_version` drift warning means
