# mehmory — Design Spec

Date: 2026-07-28
Status: approved

## What

Hook-enforced, model-maintained markdown wiki memory for Claude Code. Ships as a Claude Code plugin (hooks + skills + schema) plus a thin CLI (onboard, search, doctor). TypeScript/Node, bundled. No MCP server, no embeddings, no external services. Storage is a git-backed directory of markdown under `~/.mehmory/`.

Positioning: deliberately "meh"-tier — a noticeable improvement in harness memory and continuity, built from boring parts. Does what it says.

Research basis: `.research/` (untracked) — studies of jcode, Sulcus, MemPalace, context-mode, plus Karpathy's LLM-wiki pattern. Key synthesis: store *compiled knowledge* (wiki pages the model maintains) rather than records + retrieval machinery; use hooks for deterministic cadence; keep all judgment work in-session where tokens are visible.

## Problems solved

1. Session amnesia — preferences, decisions, procedures survive across sessions.
2. Compaction data loss — PreCompact capture saves state exactly where context dies.
3. Re-derivation waste — project knowledge compiled once, not re-explored each session.
4. Contradictory memory — supersession is editorial (the model rewrites the line at integrate time), resolved once, permanently.
5. Memory distrust — storage is human-readable markdown with git history; user can read, edit, and revert everything.
6. Cold start — onboarding mines existing Claude Code transcripts so the wiki exists before the first session.

## Non-goals (v1)

Semantic search/embeddings; stored graphs (links in markdown are the graph); MCP server; team/sync features; decay formulas; other harnesses (adapter seam later); autonomy beyond hooks; SOTA benchmark claims.

## Architecture

Three planes:

- **Files** — the memory itself: markdown wiki per scope under `~/.mehmory/`. The model reads and writes it with ordinary Read/Edit/Grep; memory operations are file operations. Zero recall infrastructure required.
- **Hooks** — the enforcement: deterministic TS scripts on SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd. Capture and injection cadence never depend on model cooperation. **No LLM calls inside hooks, ever.**
- **Skills + schema** — the intelligence: plugin skills (`integrate`, `lint`, `onboard-session`, `remember`) plus `SCHEMA.md`, the wiki's constitution (page conventions, house style, size caps, decay policy, supersession rules). All judgment work happens in-session at explicit moments where token cost is visible.

Token principle: **code does everything scheduled; the model does everything judged, only at explicit moments.**

## Storage layout

```
~/.mehmory/                     # one git repo, auto-committed
├── SCHEMA.md                   # conventions; injected into integrate/lint prompts
├── config.json                 # thresholds, all defaulted
├── .state/                     # session counters, topic cache, errors.log (gitignored)
├── global/
│   ├── identity.md             # user prefs, tooling, style — core block
│   ├── index.md                # catalog: one line per page
│   ├── log.md                  # append-only: "## [date] op | summary"
│   ├── inbox.md                # captured, awaiting integrate
│   └── pages/*.md
└── projects/<path-hash>/
    ├── project.md              # what/stack/state/current focus
    ├── index.md  log.md  inbox.md
    ├── pages/*.md              # decisions, procedures, entities, gotchas
    └── archive/*.md            # decayed out of index; still greppable
```

Conventions (enforced via SCHEMA.md + code caps):

- Page = topic (`deploy-process.md`); fact = bullet line within it. Memory ≠ file.
- Frontmatter per page: `updated`, `type` (decision|procedure|entity|preference|gotcha), optional `refs`.
- `[[wikilinks]]` between pages are the graph. Backlinks/orphans are derived (grep), never stored.
- Hard caps: identity.md / project.md ≤ ~200 tokens; index.md ≤ ~500; page ≤ ~1500 (split when over).
- House style: caveman-telegraphic bullets (more facts per injected token); full prose only where nuance demands.
- Secret/PII regex filter before every write (keys, tokens, passwords, .env-style values).
- Scope rule: user-level facts (preferences, tooling) → global; codebase facts → project.

## Session lifecycle (hooks)

| Hook | Behavior | Budget |
|---|---|---|
| **SessionStart** (startup\|resume\|compact) | Inject `identity.md` + `project.md` + `index.md`, ≤ ~800 tokens total (code-enforced truncation). If inbox over threshold (~10 entries or 8 KB): append integrate nudge. Mechanical decay pass (file ops only): re-sort index recency-first, demote >60d pages below an Archive divider, move >90d pages to `archive/`. | <1 s |
| **UserPromptSubmit** | Keyword/FTS match of prompt against page titles + headings → inject *pointers only* ("relevant: `pages/auth-decisions.md`"), max 3. Topic-stability cache (Jaccard on prompt tokens, 5-min TTL) skips repeat lookups. Silent when no match. | <100 ms |
| **Stop** | Every N=15 user messages: (a) deterministic distill of transcript delta → `inbox.md` (user messages, corrections, decision markers, error→resolution pairs); (b) block-with-reason once telling the model to append session learnings to inbox (`stop_hook_active` guard prevents loops). | <5 s |
| **PreCompact** | Same both-layer capture in emergency mode: distill everything since last capture + block instructing the model to save state now. | <15 s |
| **SessionEnd** | Background final distill → inbox; append log entry; `git commit`. Returns instantly. | <1 s fg |

Per-session state (message counters, topic cache, capture offsets) in `~/.mehmory/.state/<session-id>.json`.

## Operations

### Integrate (skill, model-driven, in-session)

1. Read `SCHEMA.md` + inbox + index.
2. Per inbox entry: merge into the matching page (edit the line — supersession is editorial), create a page for new topics, update `[[links]]` and index one-liners, refresh frontmatter `updated`.
3. Clear processed entries, append log entry, commit.

Triggers: SessionStart nudge past threshold, or `/mehmory:integrate` anytime.
Contract: **inbox is never lost** — entries leave inbox only after landing in a page. Crash mid-integrate leaves inbox intact and git state visibly dirty.

### Lint (skill, explicit only)

Staleness sweep (claims vs `updated` dates), orphan pages (no inbound links, absent from index), contradiction scan across pages, missing-page suggestions, archive candidates. Reports first; applies what the user approves. Piggyback rule: integrate fixes what it touches; lint is the full pass.

### Decay

- **Mechanical (code, free, every SessionStart):** recency-sorted index; >60d → Archive divider; >90d → `archive/` move. Thresholds in `config.json`.
- **Editorial (model, piggybacked):** integrate/lint judge content staleness only when already touching a page. Ephemeral fields (`current focus`) are marked in SCHEMA.md; integrate must refresh-or-delete them each pass.
- Nothing is deleted, ever: archive + git history = decay with undo. No scheduled LLM passes.

### Onboarding

`mehmory onboard` (CLI):

1. Scan `~/.claude/projects/*/`; list projects, session counts, sizes; user picks scope (default: current project).
2. **Pre-distill (code, no LLM):** parse JSONL recent-first — user messages, correction patterns, error→resolution pairs, decision markers; caps (default: last 30 sessions / 500 KB distilled) → seed `inbox.md` with source-session references.
3. Print handoff: "inbox seeded — run `claude`, then `/mehmory:integrate`." The first integrate builds the initial wiki in-session, where cost is visible.
4. Extras: warn when Claude Code `cleanupPeriodDays` risks transcript expiry; `--global` distills cross-project preferences into `global/inbox.md`.

Chunked + resumable via state file. Onboarding is just a big first inbox — same machinery as runtime capture, no second code path.

## Components

**Plugin** (Claude Code marketplace):
- `hooks/hooks.json` + `hooks/*.mjs` — the 5 hooks, bundled, node runtime
- `skills/` — `integrate`, `lint`, `onboard-session`, `remember` (explicit mid-session save → append inbox via Edit; replaces any MCP need)
- `SCHEMA.md` template — copied to `~/.mehmory/` at init; the user's copy wins thereafter (co-evolution)

**CLI** (single bundled file, npm-distributable):
- `init` — create `~/.mehmory`, git init, copy schema, verify plugin hooks (prints install command if missing)
- `onboard` — as above
- `search <q>` — FTS5 via `node:sqlite` (porter + trigram tables, context-mode schema) over pages + archive + log; index rebuilt lazily from file mtimes; used by humans and by the model via Bash
- `doctor` — hooks wired, dirs/git healthy, inbox size, last integrate/commit, page counts, state sanity, error log tail, KPI budget violations
- `status` — one-screen wiki summary
- `stats [--project]` — aggregates from `stats.jsonl`: hook latency p50/p95, injection tokens per SessionStart, capture volume, integrate cadence, inbox age; per-project split via path-hash

Shared library between CLI and hooks: transcript parsing, distill rules, config, secret filter. Strict TS, no `any`, explicit return types.

## Error handling

- Hooks **fail open**: any error → log to `.state/errors.log`, exit 0. Memory must never break the harness.
- Atomic writes everywhere (temp + rename). Inbox/log append-only. Wiki regenerable from inbox + log in the worst case.
- Injection caps enforced by code (truncate + doctor warning), not by trusting the model.
- Secret filter applied at every write boundary — both deterministic distill output and the block-with-reason instructions.
- `git commit` failure is non-fatal (uncommitted repo still functions; doctor flags it).

## Instrumentation

Every hook invocation appends one JSONL line to `~/.mehmory/.state/stats.jsonl`: `{ts, project: <path-hash>, hook, ms, injected_tokens?, pointers_offered?, inbox_bytes?, captured_entries?}`. Integrate/lint/onboard append their own line (`entries_integrated`, `pages_touched`) as part of the log-entry step they already perform. File rotates at ~5 MB. `mehmory stats` aggregates; `doctor` flags budget violations.

KPI proof split: mechanical KPIs (injection budget, hook latency, capture survival, integrate cadence) are proven per-project from `stats.jsonl`; judgment KPIs (recall correctness, contradiction rate) come from the dogfood eval harness and lint reports — runtime stats cannot prove them and don't pretend to.

## Testing

- **Unit:** distill rules (JSONL fixtures → expected inbox output), secret filter, decay file ops, FTS search, injection-cap truncation.
- **Integration:** hook scripts are pure stdin/stdout — feed fixture JSON, assert output/exit codes.
- **Eval (dogfood harness, not CI):** seeded-session recall ("what did we decide about X?"), injection p95 ≤ 1k tokens, hook latency budgets, post-lint contradiction count = 0.

## KPIs

| KPI | Target |
|---|---|
| Time-to-first-useful-recall (with onboard) | minutes after install |
| Cold-start recall of ≤2-week-old decisions | works |
| Injection budget (SessionStart) | ≤800 tokens (code-enforced cap) |
| Hook latency | SessionStart <1s, UserPromptSubmit <100ms, Stop <5s p95 |
| Capture survival across compaction | ~100% of flagged decisions |
| Contradiction rate after integrate | ~0 |
| Meta | removing it feels noticeably worse |

## Decisions log

| Decision | Choice | Alternatives considered |
|---|---|---|
| Packaging | Plugin + thin CLI | plugin-only; CLI+installer |
| Capture | Both layers: deterministic distill + block-with-reason | either alone |
| Integrate trigger | SessionStart threshold nudge + explicit command | auto headless at SessionEnd; command-only |
| Storage | `~/.mehmory`, path-hashed per project | repo-local `.mehmory/`; hybrid overlay |
| Stack | TypeScript/Node, bundled | Rust binary; bash+node |
| MCP | None in v1 | search tool; search+remember |
| Prompt recall | Pointer injection + topic cache | full snippets; none |
| V1 scope | onboard, lint, doctor/status, auto git commits all in | — |
