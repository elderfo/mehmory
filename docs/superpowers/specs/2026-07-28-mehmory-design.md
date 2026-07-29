<!-- /autoplan restore point: /home/cgetsfred/.gstack/projects/elderfo-mehmory/main-autoplan-restore-20260728-232446.md -->
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

---

# /autoplan Review Addendum (2026-07-28)

Reviewed by /autoplan: CEO (Phase 1), Eng (Phase 3), DX (Phase 3.5). UI scope: none — design phase skipped. Codex CEO outside voice: `2026-07-28-mehmory-ceo-review.md` (full text).

## Review-mandated spec changes (auto-approved under blast-radius rule)

1. **Concurrency safety** — two concurrent sessions on one project: inbox/log writes are O_APPEND single-write lines; `git commit` retries once on index.lock then defers to next hook invocation. (S1)
2. **FTS rebuild off hot path** — UserPromptSubmit never rebuilds the index synchronously; rebuild happens at SessionEnd/background, with page-title grep fallback when index is stale/absent. (S1/S7)
3. **State-file corruption rescue** — unparseable `.state/<session>.json` → reset to fresh state, log to errors.log, continue. Never crash a hook. (S2)
4. **Node version guard** — `node:sqlite` needs Node ≥22.5; `doctor` checks, `search` degrades to grep with a warning. (S2)
5. **Injection framing** — all hook-injected wiki content is wrapped in explicit data-only framing (not instructions); deterministic distill captures user messages/corrections/decision markers only. Persistent-prompt-injection mitigation; load-bearing. (S3)
6. **Secret filter claim softened** — regex filter is best-effort pattern matching (keys/tokens/.env shapes); it does not reliably catch PII or prose secrets. Documented limitation, not a guarantee. (S3)
7. **Onboard `--dry-run`** — preview what would be distilled before writing anything; onboarding is the highest-risk data operation and runs before the user has calibrated trust. (S3)
8. **Capture offsets** — transcript delta tracked by byte offset in the session JSONL (not message count), so compact/resume never double-captures or skips. (S4)
9. **Token estimation method** — caps enforced with chars/4 heuristic, ±20% tolerance documented; no tokenizer dependency. (S7)
10. **errors.log rotation** — rotate at ~5 MB, same policy as stats.jsonl. (S8)
11. **Distribution pipeline** — CI workflow: build, test, npm publish + plugin marketplace release on tag. In v1 scope as P2. (S9)
12. **Schema versioning** — SCHEMA.md carries `schema_version`; doctor warns when the user's copy drifts behind the plugin's template major version. Co-evolution stays, drift becomes visible. (S10)
13. **Provenance refs** — inbox entries carry source-session references at runtime capture too (not just onboarding); integrate may carry them into page `refs` frontmatter. Distinguishes observed from inferred. (Codex)
14. **Measurable KPIs** — KPI table sharpened: time-to-first-useful-recall ≤5 min from init; cold-start recall ≥70% relevant in top-3 pointers on a labeled query set; contradiction count 0 after lint; recall utility tracked as pointers-followed / pointers-offered from stats.jsonl. (Both voices)

## NOT in scope (deferred, with rationale)

- MCP server / API-user reach — settled non-goal; `remember` skill covers the need in-harness. (Claude voice rejected: personal tool, not TAM play.)
- Team/multi-user schema, sync — non-goal v1; storage format doesn't preclude later.
- Embeddings/semantic search — premise P5 accepted at gate; recall-precision eval (KPI above) is the falsification instrument. Revisit only if eval fails.
- Scheduled/background LLM maintenance — violates the token-visibility principle; threshold nudge is the chosen mechanism.
- Other harnesses — adapter seam later, per spec.
- Statusline memory indicator, `doctor --fix` — delight items, deferred to TODOS.

## What already exists

- FTS5 porter+trigram schema ← context-mode (spec reuses).
- Transcript JSONL structure, hook contracts ← Claude Code; studied in `.research/`.
- Wiki/decay/supersession patterns ← Karpathy LLM-wiki, Sulcus/MemPalace studies.
- Secret regex patterns ← standard corpora. Nothing is rebuilt that exists.

## Dream state delta

CURRENT (CLAUDE.md-only, amnesia) → THIS PLAN (enforced wiki memory, measurable recall, v1 complete) → 12-MONTH IDEAL (adapter seam to other harnesses, proven KPIs). Plan moves toward ideal; the 5-hook Claude Code coupling is the accepted debt.

## Error & Rescue Registry

| Codepath | Failure | Rescued? | Action | User sees |
|---|---|---|---|---|
| Any hook | uncaught error | Y | log errors.log, exit 0 | nothing (fail open) |
| Hook | corrupt state JSON | Y (added) | reset state, log | nothing |
| Hook/CLI | git commit index.lock | Y (added) | retry 1x, defer | nothing; doctor flags |
| CLI search | Node <22.5 no sqlite | Y (added) | grep fallback + warn | warning line |
| SessionStart | wiki dirs missing | Y | no-op + init hint | one hint line |
| Integrate | crash mid-run | Y | inbox intact, git dirty | dirty repo, re-run |
| Onboard | interrupt mid-chunk | Y | state file resume | resume message |
| Distill | malformed transcript line | Y | skip line, count in stats | nothing |
| Any write | disk full / perm | Y | temp+rename fails atomically, log | doctor flags |

## Failure Modes Registry

| Codepath | Failure mode | Rescued | Test | User sees | Logged |
|---|---|---|---|---|---|
| Hooks (all) | crash | Y | Y (fixture stdin/stdout) | fail-open | Y |
| Inbox append | concurrent sessions | Y (added) | Y (added) | none | Y |
| Pointer inject | irrelevant pointers | n/a | Y (eval set, added) | noise | Y (stats) |
| Capture | secret leak past regex | partial | Y (corpus test) | dry-run preview | N |
| Identity | worktree/clone fork | OPEN → UC3 | Y (added) | split memory | doctor |
| Injection | poisoned content persists | Y (framing) | Y | — | N |

No CRITICAL silent gaps remain; identity fork is the one OPEN item, pending UC3 at the approval gate.

## Architecture diagram

```
Claude Code session                     ~/.mehmory/ (git repo)
┌──────────────────────┐   inject      ┌───────────────────────────┐
│ SessionStart hook ───┼──────────────▶│ identity/project/index.md │
│ UserPromptSubmit ────┼──pointers────▶│ pages/*.md   archive/*.md │
│ Stop / PreCompact ───┼──distill─────▶│ inbox.md  log.md          │
│ SessionEnd ──────────┼──commit──────▶│ .state/ (counters, stats) │
└─────────┬────────────┘               └───────────▲───────────────┘
          │ shared lib (parse/distill/filter/config)│
┌─────────▼────────────┐    reads/writes via skills │
│ CLI: init onboard    ├────────────────────────────┘
│ search doctor status │      in-session skills: integrate, lint,
│ stats                │      remember, onboard-session
└──────────────────────┘
```

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Mode = SELECTIVE EXPANSION | Mechanical | — | autoplan override | — |
| 2 | CEO | Approach = plugin+thin CLI (as specced) | Mechanical | P1 | completeness-max of logged alternatives | plugin-only; CLI+installer |
| 3 | CEO | Reject TAM/team/MCP reframing (Claude voice) | Mechanical | P6/user positioning | deliberately personal meh-tier tool; MCP a settled non-goal | MCP server, team schema |
| 4 | CEO | Add concurrency safety | Mechanical | P1 | silent data race | ignore |
| 5 | CEO | FTS rebuild off hot path | Mechanical | P3 | 100ms budget | sync rebuild |
| 6 | CEO | State-corruption + node:sqlite + git-lock rescues | Mechanical | P1 | close error GAPs | leave gaps |
| 7 | CEO | Injection data-framing | Mechanical | P1 | persistent prompt injection | trust content |
| 8 | CEO | Soften PII claim; add onboard --dry-run | Mechanical | P5 | honest limits; preview trust | overclaim |
| 9 | CEO | Byte-offset capture tracking | Mechanical | P5 | compact-safe | message counts |
| 10 | CEO | chars/4 token heuristic documented | Mechanical | P5 | explicit over clever | tokenizer dep |
| 11 | CEO | errors.log rotation | Mechanical | P1 | unbounded file | ignore |
| 12 | CEO | Distribution CI in scope P2 | Mechanical | P1 | code without distribution unusable | silent defer |
| 13 | CEO | schema_version + drift warning | Mechanical | P1 | upgrade path | silent drift |
| 14 | CEO | Provenance refs first-class | Mechanical | P1 | observed vs inferred | none |
| 15 | CEO | Measurable KPI rewrite | Mechanical | P1 | falsifiability | vibes |
| 16 | CEO | Purge command? | TASTE → gate | — | codex privacy point vs "never delete" | — |
| 17 | CEO | remember:-prefix capture? | TASTE → gate | — | delight, in blast radius | — |
| 18 | CEO | V1 scope narrowing | USER CHALLENGE → gate | — | both voices | — |
| 19 | CEO | Decay: per-page override | USER CHALLENGE → gate | — | both voices | — |
| 20 | CEO | Project identity: stable key | USER CHALLENGE → gate | — | both voices | — |
| 21 | Eng | Integrate = snapshot-clear (late appends survive) | Mechanical | P1 | "inbox never lost" contract was false under concurrency | naive clear |
| 22 | Eng | Path-scoped git staging + per-op commit ownership | Mechanical | P5 | cross-session commit of half-done transactions | repo-wide add |
| 23 | Eng | SessionEnd = durable queue entry, claimed idempotently later | Mechanical | P1 | background task not guaranteed to survive shutdown | fire-and-forget |
| 24 | Eng | Capture cursor = file identity + offset + last-record hash; stable entry IDs | Mechanical | P1 | byte offset alone fails on truncate/rotate; replay must be harmless | offset only |
| 25 | Eng | Untrusted captures never auto-injected into identity/project.md; explicit promotion only; truncate before framing | Mechanical | P1 | framing is mitigation, not boundary | trust framing alone |
| 26 | Eng | Deterministic truncation priority: index detail → project → identity last | Mechanical | P5 | undefined truncation order | implementer guess |
| 27 | Eng | Distill contract = enumerated marker patterns + JSONL fixtures as spec | Mechanical | P5 | "decision markers" undefined | vague prose |
| 28 | Eng | Pointer matching uses full-text FTS, not titles/headings only | Mechanical | P1 | facts live in bullet bodies | title match |
| 29 | Eng | Rate-limited stderr warning on repeated hook failures | Mechanical | P1 | fail-open can silently disable memory for weeks | doctor-only |
| 30 | Eng | Schema split: machine format version (code-owned) vs editorial guidance (user-owned) | Mechanical | P5 | "user copy wins" breaks parsers | single file wins |
| 31 | Eng | Missing core files → skip + init hint | Mechanical | P1 | unspecified nil path | crash/undefined |
| 32 | Eng | Reject "Stop-loop unguarded" finding | Mechanical | — | FP: spec line 73 names stop_hook_active guard | — |
| 33 | Eng | 16 test requirements added (see test plan artifact) | Mechanical | P1 | plan-stage coverage 0/16 | defer tests |

## Eng review additions (auto-approved)

15. **Integrate transactionality** — integrate snapshots the inbox, merges, then removes only snapshotted entries; entries appended concurrently survive. "Inbox is never lost" now holds under concurrency.
16. **Git transaction ownership** — every operation stages only the paths it touched and commits its own transaction; never `git add -A`. A dirty tree left by a crash is flagged by doctor, not committed by the next session.
17. **SessionEnd durability** — final distill enqueues a durable job (file in `.state/queue/`); the next foreground hook or CLI invocation claims it idempotently. No orphaned background work.
18. **Capture cursor hardening** — cursor = transcript file identity + byte offset + last-record hash; advances only past complete validated records; distilled entries carry stable IDs so replay is a no-op.
19. **Injection trust boundary** — data framing is mitigation, not boundary: captured/untrusted text is never auto-injected into `identity.md`/`project.md`; promotion into core files happens only via explicit in-session integrate approved edits. Truncation runs before frame-wrapping.
20. **Truncation priority** — deterministic order when over budget: index detail first, project.md second, identity.md last.
21. **Distill contract** — marker patterns enumerated in spec; JSONL fixtures define the contract (fixtures are normative).
22. **Full-text pointer matching** — UserPromptSubmit matches FTS over page bodies, returns pointers only. KPI caveat documented: pointers-offered is measurable; fact-actually-used is not observable in v1.
23. **Failure visibility** — repeated hook failures emit a rate-limited one-line stderr warning; not doctor-only.
24. **Schema split** — machine-parsed format constants live in code with `format_version`; SCHEMA.md is editorial guidance only, user-owned, drift-warned.

## DX review additions (auto-approved)

25. **Quickstart contract** — "First 5 Minutes" doc: numbered install→init→onboard→session→integrate→search flow with expected output per step; tested on a clean machine; TTHW ≤5 min is a release gate. Magical moment leads: onboard, then the first session already knows the project.
26. **CLI contract** — exact syntax, defaults, exit codes for every command; `--json` on search/doctor/status with versioned schemas (agent-deterministic output, no decorative prose); search arity documented (`search QUERY [--project|--global|--all] [--limit N] [--json]`); init/onboard and status/doctor boundaries defined; npm package + binary names pinned.
27. **Error message template** — every surfaced error: `MEHMORY E_<CODE>: <what>. <consequence — Claude Code unaffected>. Fix: <copy-paste command>. Details: errors.log`. doctor prints copy-paste fixes.
28. **Node check at init** — Node ≥22.5 verified at install/init with upgrade guidance, not discovered at first search.
29. **Docs deliverables scoped** — README quickstart, command reference w/ examples, troubleshooting indexed by error text, privacy + secret-filter-limits page, upgrade notes. README test: unfamiliar user installs in <2 min using only copied commands.
30. **Escape hatches** — config.json documented with sample: `injection.budget_tokens`, `decay.{enabled,archive_days,purge_days}`, `secrets.{patterns,whitelist}`, per-hook toggles; `MEHMORY_HOME` env override; `/mehmory:pause` / `resume` capture switch (session/project/global precedence).
31. **Lifecycle design** — uninstall (plugin gone, data intact) vs data deletion are separate operations; export/restore documented. Purge command itself = UC4 at gate.
32. **KPI table sync** — main KPI table updated to the measurable targets in this addendum (TTHW ≤5 min, recall ≥70% top-3).

### DX Scorecard (plan stage)

| Dimension | Initial | After fixes above |
|---|---|---|
| Getting Started | 4/10 | 9/10 |
| API/CLI/SDK | 5/10 | 9/10 |
| Error Messages | 4/10 | 8/10 |
| Documentation | 2/10 | 8/10 |
| Upgrade Path | 4/10 | 7/10 (purge pending UC4) |
| Dev Environment | 6/10 | 8/10 |
| Community | 5/10 | 5/10 (held light, personal tool) |
| DX Measurement | 7/10 | 8/10 |
| **Overall** | **4.6/10** | **7.8/10** |
| TTHW | 5-15 min (est) | ≤5 min (release-gated) |
| Product type | CLI tool + Claude Code plugin/skill | Mode: DX POLISH |

### Developer journey map

| Stage | Developer does | Friction | Status |
|---|---|---|---|
| Discover | npm / marketplace listing | no listing scoped | fixed (item 29) |
| Install | plugin + npm -g | two installs, Node req | fixed (28, 25) |
| Hello world | init → onboard → first session | order undocumented | fixed (25) |
| Real usage | hooks run silently; integrate on nudge | silent failures | fixed (27, item 23) |
| Debug | doctor/status/errors.log | no copy-paste fixes | fixed (27) |
| Upgrade | plugin update + format_version | no migration/uninstall design | partial (31, UC4) |

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 34 | DX | Persona = CC power user + AI agent; mode DX POLISH | Mechanical | autoplan override | — | — |
| 35 | DX | TTHW target = competitive tier ≤5 min, release-gated | Mechanical | P1 | red-flag tier loses to CLAUDE.md's zero-install | champion tier (defer) |
| 36 | DX | Magical moment = onboard demo ("already knows my project") | Mechanical | P5 | lowest-effort vehicle at tier | playground/video |
| 37 | DX | Items 25-32 (quickstart, CLI contract, error template, node check, docs, escape hatches, lifecycle, KPI sync) | Mechanical | P1/P5 | both voices converge; all in blast radius | ship undocumented |
| 38 | Gate | UC1: v1 stays ALL-IN | User decision | — | user kept original direction over both models | staged v1 |
| 39 | Gate | UC2: per-page decay class accepted | User decision | — | `decay: evergreen\|ephemeral\|default` frontmatter; age rules apply to default only | age-only |
| 40 | Gate | UC3: stable project identity accepted | User decision | — | git remote slug, fallback toplevel realpath hash; alias map in config | path-hash |
| 41 | Gate | UC4: `mehmory purge` accepted (safety) | User decision | — | page/session/project scopes, dry-run, typed confirm, history-rewrite warning; separate from uninstall | never-delete |
| 42 | Gate | T2: `remember:` prompt-prefix capture accepted | User decision | — | prefix check + secret filter + inbox append in UserPromptSubmit | skill-only |

## Gate outcomes (2026-07-28) — spec deltas

- **Scope:** v1 remains all-in (onboard, lint, doctor/status, stats, decay, auto-commit).
- **Decay:** pages carry `decay: evergreen | ephemeral | default`; mechanical 60/90d rules apply to `default` only; `ephemeral` refreshed-or-deleted each integrate (supersedes age-only decay in Decisions log).
- **Identity:** project key = git remote slug; fallback = toplevel realpath hash; alias map in `config.json` for merges/splits (supersedes path-hash in Decisions log).
- **Purge:** `mehmory purge <page|--session <id>|--project|--all>` with `--dry-run`, typed confirmation, optional export, explicit git-history-rewrite warning. "Nothing is deleted, ever" becomes "nothing is deleted *silently*". Separate from uninstall.
- **Capture:** `remember: <text>` prefix in UserPromptSubmit appends (filtered) text to inbox directly.

**APPROVED** — /autoplan review complete. Restore point: see comment at top of file.

## Run-1 amendments (2026-07-29)

Applied when run 1 (foundation library) landed. Items 1–8 resolve blocker/major defects
found by the spec-stage adversarial review; 9–14 are decisions this spec never made that
runs 2–3 cannot add later without breaking run 1's contracts. **Items 15 and 16 change
contracts this spec had fixed** and were raised explicitly at the approval gate.

1. **Injection allocation** (resolves BLOCKER: 200+200+500 = 900 against an 800 budget).
   Authoring caps and injection allocations are different things. Authoring caps stand;
   *injection* allocates identity 200 / project 200 / index 400 = 800, truncating index
   detail first, then project, then identity. Identity is never dropped entirely. The
   data-only frame is applied **after** truncation so framing cannot re-exceed the budget.
2. **Record atomicity** (resolves MAJOR: `O_APPEND` interleave). Every inbox/log/stats
   record is exactly one `\n`-terminated line written in a single `write()`; embedded
   newlines are JSON-escaped. Documented ceiling **4 KiB**, above which the lockfile path
   is used.
3. **`index.lock` defer bound** (resolves BLOCKER: unbounded defer). Retry once after
   100 ms, then leave staged and return `deferred: true`. The next `commitPaths` commits
   whatever the index holds — not merely its own `paths` argument — so a deferred
   transaction cannot be orphaned by a later caller passing a narrower list. Deferral is
   normal operation and emits no error.
4. **Queue claim protocol** (resolves BLOCKER: undefined durability). Claim by atomic
   `rename()` into `queue/claimed/`; stale claims reclaimable by mtime; 3 failed claims
   move the job to `queue/failed/`.
5. **Concurrent-session decay race** (resolves BLOCKER). Index rewrites and decay run
   under `withProjectLock`; lock acquisition is itself fail-open after a bounded wait
   (50 × 100 ms, then proceed without the lock and log `E_LOCK_TIMEOUT`).
6. **Cursor rotation/truncation** (resolves MAJOR). The cursor carries `dev:ino` and
   `size`; rotation or truncation resets the offset, and stable entry IDs
   (`sha256(sessionId + record.uuid)`) make replay a no-op.
7. **Worktree/clone identity fork** (resolves BLOCKER: left OPEN). Clones and worktrees of
   one remote deliberately share one memory; the alias map overrides. This is irreversible
   once user directories exist on disk — see ADR A5 in `docs/WORLD_MODEL.md`.
8. **`pointers-followed` KPI** (resolves MAJOR: self-contradiction). Removed from the v1
   KPI table; `pointers_offered` remains as the measurable proxy. Addendum item 14 is
   amended to match item 22.
9. **Toolchain** (unspecified here): pnpm, vitest, tsup, eslint + prettier, husky.
10. **`ephemeral` staleness threshold** is deferred to run 2 with the integrate skill that
    owns it. Run 1 defines only the `decay` frontmatter constants.
11. **FTS5 availability** — measured, not inferred: `node:sqlite` on Node 22.22.3 /
    SQLite 3.51.3 builds `fts5` with both `porter unicode61` and `trigram` tokenizers.
    No spec change; recorded as evidence for run 3.
12. **Sync/async boundary** (ADR A9): the core library is synchronous at its boundary. No
    exported function returns a Promise, lint-enforced.
13. **Module format** (ADR A10): ESM only.
14. **Process-exit ban** (ADR A11): core never calls `process.exit`/`process.abort` and
    never throws across its boundary. Lint-enforced, which is what makes the "hooks fail
    open" promise true rather than hoped-for.
15. **Warning channel — amends addendum item 23.** That item specified "a rate-limited
    one-line stderr warning". A hook exiting 0 has its stderr effectively swallowed, and
    agents never see stderr at all, so that channel fails both audiences. Repeated failures
    instead travel `errors.log` → `pendingWarnings()` → a one-line `SessionStart`
    injection (wired in run 2). Rate-limit state lives in `.state/warnings.json`, keyed by
    error code, default 1 per hour.
16. **Conditional `Fix:` clause — amends addendum item 27.** That item mandated a `Fix:`
    clause on every surfaced error. Errors now declare a kind; `informational` errors
    (`E_LOCK_TIMEOUT`, `E_DISTILL_LOSSY`) omit the clause rather than inventing advice for
    failures with no correct user action. Rendered form:
    `MEHMORY E_<CODE>: <what>. <consequence>. [Fix: <command>. ]Details: <errors.log path>`

**Decay class names.** Run 1's `src/schema/format.ts` uses the three names fixed by the
2026-07-28 gate outcome above — `evergreen | ephemeral | default` — which supersede the
Decisions log. Recorded here because these are parsed from page frontmatter by run 2, so
drift between this spec and the code breaks integrate silently.
