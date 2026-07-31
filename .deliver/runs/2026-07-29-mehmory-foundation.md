# Run: mehmory-foundation

mode: single
approved: 2026-07-29 (rev 1, plan + spec amendments 15 & 16)
landed: 2026-07-29T19:06:38Z (PR #1 squash-merged as 65cd8a0; source: gh pr view 1)
retroed: 2026-07-29 (retro at .deliver/PRIORS-retro-2026-07-29.md)
case_studied: 2026-07-29 (package at .deliver/case-studies/2026-07-29-mehmory-foundation/)
session: 855328e6-ef7f-453d-a517-dcc59e391f42
model: claude-opus-5
context_at_approval: fresh session, plan re-read from run file

## Proposed plan (rev 1)

# Plan: mehmory-foundation

Run 1 of 3 delivering `docs/superpowers/specs/2026-07-28-mehmory-design.md` (approved
v1, all-in). Slicing chosen by the user at intake: run 1 foundation (this plan),
run 2 hooks + skills + plugin packaging, run 3 CLI surface + docs + CI. v1 scope is
unchanged; it lands in three merges.

## Problem

The mehmory spec is approved but nothing exists: the repo holds two markdown specs and
a `.gitignore`. Every later part of v1 — 5 hooks, 4 skills, 8 CLI commands — depends on
the same handful of primitives (project identity, config, atomic/append-safe writes, a
git wrapper, transcript parsing and distill, the capture cursor, the secret filter, the
token cap). Building those primitives inside the hooks or inside the CLI produces two
divergent implementations of each, which the spec explicitly forbids ("Shared library
between CLI and hooks"). Additionally, the spec-stage adversarial review found 6 blocker
and 9 major defects, of which 8 are defects *in these primitives* — they must be resolved
in the contract before either consumer is written.

## Done when

Each criterion is checkable by a command a verifier runs itself.

1. `pnpm install && pnpm build && pnpm lint && pnpm test` all exit 0 from a clean clone.
2. `pnpm test` reports **zero failing** tests and covers every numbered item below with at
   least one assertion; `pnpm exec tsc --noEmit` exits 0 with `strict: true` and no `any`
   in `src/` (verified by an eslint rule, not by eyeball).
3. **Identity:** `resolveProjectKey()` returns the normalized git-remote slug
   (`github.com/owner/repo`) for a repo with a remote; falls back to
   `local/<sha256(realpath(toplevel))[0..12]>` with no remote; falls back to
   `local/<sha256(realpath(cwd))[0..12]>` outside a repo. Two git worktrees of one remote
   resolve to the **same** key. A `config.json` alias entry overrides the computed key.
   Tests cover all five cases using temp repos.
4. **Config:** `loadConfig()` returns fully-defaulted config when no `config.json` exists;
   user values override per-key (deep merge, not replace); `MEHMORY_HOME` overrides the
   root; an unparseable `config.json` yields defaults + an `E_CONFIG_PARSE` entry in
   `errors.log` and never throws. Every key named in the spec (`injection.budget_tokens`,
   `decay.{enabled,archive_days,purge_days}`, `secrets.{patterns,whitelist}`, per-hook
   toggles, `identity.aliases`) is present in the defaults with the spec's values.
5. **Errors:** every error is a typed domain error carrying a stable `E_<CODE>` and a
   declared kind (`actionable` | `informational`); `formatUserError()` renders
   `MEHMORY E_<CODE>: <what>. <consequence>. [Fix: <command>. ]Details: <errors.log path>`,
   emitting the `Fix:` clause only for `actionable` errors. Tests assert the exact rendered
   string for the four worked examples in the UX section, including that
   `E_LOCK_TIMEOUT` and `E_DISTILL_LOSSY` render **without** a `Fix:` clause.
   `failOpen(fn, fallback)` returns the fallback and logs on any throw, never rethrows.
6. **Append safety:** `appendRecord()` writes exactly one `\n`-terminated line per call in
   a single `write()` on an `O_APPEND` handle, JSON-escaping any embedded newline. A test
   spawns 8 concurrent processes appending 200 records each and asserts the file has
   exactly 1600 lines, every one parseable, none interleaved. Records at or above the
   documented 4 KiB atomicity ceiling take the lockfile path instead; a test covers that
   boundary.
7. **Lock:** `withProjectLock()` grants exclusive access via `open(..., 'wx')`; a lock
   whose mtime is older than `lock.stale_ms` (default 30000) is reclaimed; contention
   retries at most 50 × 100 ms, then proceeds **without** the lock and logs
   `E_LOCK_TIMEOUT` (fail-open — memory must never block the harness). Bound asserted by
   test, not by prose.
8. **Git:** `commitPaths(paths, message)` stages **only** the given paths (never
   `git add -A`), retries once after 100 ms on `index.lock`, and on a second failure
   returns `{ committed: false, deferred: true }` leaving the tree staged. Accumulation is
   explicit: the next `commitPaths` call commits **whatever the git index holds**, not just
   its own `paths` argument, so a deferred transaction can never be orphaned by a later
   caller passing a narrower path list. Tests: path-scoped staging leaves an unrelated
   dirty file uncommitted; a held `index.lock` produces `deferred: true` and no throw; a
   following call with a *different* path list commits both transactions.
9. **Durable queue:** `enqueueJob()` writes `.state/queue/<id>.json`; `claimJob()` claims
   by `rename()` into `.state/queue/claimed/<id>.<pid>.json`, so exactly one of N
   concurrent claimers wins; a claim older than `queue.stale_ms` is reclaimable; a job
   failing 3 claims moves to `.state/queue/failed/`. A test runs 5 concurrent claimers
   against 1 job and asserts exactly one success.
10. **Cursor:** `readCursor()`/`advanceCursor()` persist
    `{ file_id: "<dev>:<ino>", size, offset, last_hash }`; the cursor advances only past
    complete parsed records; rotation (`file_id` change) or truncation (`size < offset`)
    resets `offset` to 0 without data loss, and replay is a no-op because entries carry
    stable IDs. Tests cover: normal advance, mid-line truncation at EOF, file rotation,
    file truncation, and a full replay producing zero new entries.
11. **Distill:** `distill(records)` extracts user messages, correction patterns,
    error→resolution pairs, and decision markers per an **enumerated** pattern list in
    `src/distill/patterns.ts`. JSONL fixtures in `test/fixtures/transcripts/` are
    normative: each fixture pairs an input transcript with its expected inbox output, and
    the test asserts exact equality. Malformed lines are skipped and counted; a pass
    skipping >10% of lines logs `E_DISTILL_LOSSY`. Each entry carries a stable
    `id = sha256(sessionId + record.uuid)` and a `source` provenance ref.
12. **Secret filter:** `redact()` catches the documented pattern corpus (AWS keys, GitHub
    and generic bearer tokens, private-key blocks, `.env`-shaped `KEY=value` secrets,
    URL-embedded credentials) with a fixture corpus test asserting both hits and
    non-hits; its documented limitation (best-effort patterns, does **not** reliably catch
    PII or prose secrets) appears in the module docstring and in `SCHEMA.md`.
13. **Token cap:** `estimateTokens()` uses chars/4 with the ±20% tolerance documented in
    the function docstring; `buildInjection()` allocates identity 200 / project 200 /
    index 400 = 800 and truncates in the spec's priority order (index detail, then
    project, then identity last), always emitting the data-only frame *after* truncation.
    A test with three oversized inputs asserts the output is ≤ `budget_tokens` and that
    identity content survives when the other two are exhausted.
14. **Schema split:** `src/schema/format.ts` exports `FORMAT_VERSION` and every
    machine-parsed constant (frontmatter keys, decay classes, page types, divider text);
    `assets/SCHEMA.md` is editorial-only, carries `schema_version` frontmatter, and is
    never parsed for behavior. `initStore()` creates the layout from the spec (`global/`,
    `projects/<key>/`, `.state/`), copies `SCHEMA.md`, runs `git init`, and is idempotent
    — a test runs it twice and asserts no error and no duplicate content.
15. `AGENTS.md` exists with the annotated directory structure, commands, and conventions.
16. Nothing in this run reads or writes `~/.mehmory` during tests — all tests run against
    a temp `MEHMORY_HOME` (asserted by a test-setup guard).
17. **Warning channel:** `recordWarning(code)` / `pendingWarnings()` persist rate-limit
    state in `.state/warnings.json`, keyed by error code, defaulting to at most one per
    hour, and the state survives across separate processes (test: two sequential process
    invocations, second suppressed; a third after a clock-advanced state file allowed).
    No module in `src/core/` writes to stderr — asserted by a lint rule, not by review.
18. **Boundary shape (A9/A10/A11):** no exported function in `src/core/` returns a Promise,
    `src/core/` contains no `process.exit`/`process.abort`, and the built package is ESM.
    All three are asserted mechanically — the first two by lint rules with a passing and a
    deliberately-failing fixture, the third by importing the built artifact from an `.mjs`
    file in a test.
19. **Crash-recovery idempotency (A6):** `initStore` recovers a half-initialized store — a
    test creates the directory tree without `.git`, and another creates `.git` without the
    layout, and asserts a subsequent `initStore` completes both without error and without
    duplicating content.

## In scope / Out of scope

**In scope:** repo scaffold and toolchain; the shared library and its contracts; storage
layout and `initStore`; the SCHEMA/format split; the enumerated distill patterns and
normative fixtures; unit tests for all of it; `AGENTS.md`.

**Out of scope:** the 5 hooks and `hooks.json` (run 2); the 4 skills and plugin packaging
(run 2); every CLI command including `search`/`doctor`/`onboard`/`purge` and the FTS
index (run 3); README/quickstart/troubleshooting docs (run 3); the CI workflow and npm
publish (run 3); the dogfood eval harness (not v1 CI, per spec). No hook is wired into
Claude Code by this run — landing it changes nothing about the user's live sessions.

## Architecture

**A1. One shared library, two consumers.** `src/core/*` owns every primitive; `src/hooks/*`
(run 2) and `src/cli/*` (run 3) are thin adapters that import it and own no logic of their
own. *Rejected:* duplicating primitives per consumer (the spec's "shared library" line
forbids it, and the distill rules would drift between capture paths); a runtime plugin
seam (nothing pluggable exists yet — speculative).

**A2. Fail-open is a library primitive, not a per-caller convention.** `failOpen()` and the
typed error taxonomy live in core and are the only sanctioned error path, so "hooks never
break the harness" is enforced in one place. *Rejected:* try/catch at each hook entry
point (five copies, one of which will be forgotten); a global `process.on('uncaughtException')`
handler (catches too late to return a valid hook response).

**A3. Storage-facing writes go through three primitives — `atomicWrite`, `appendRecord`,
`withProjectLock` — never through raw `fs`.** An eslint rule bans `node:fs` imports outside
`src/core/fs.ts`. This is what makes the concurrency claims testable in one place rather
than auditable across 30 call sites. *Rejected:* convention-only ("use atomicWrite
please") — the spec-stage review found the concurrency claim was already wrong once;
SQLite-as-store (contradicts the spec's human-readable-markdown premise, which is the
product).

**A4. Machine format is code-owned; editorial guidance is user-owned.** `FORMAT_VERSION`
and parsed constants live in TypeScript; `SCHEMA.md` is prose the user may rewrite freely.
This resolves the spec's own contradiction between "the user's copy wins" and a parser
depending on that copy. *Rejected:* single-file SCHEMA.md (user edit breaks parsing);
generating SCHEMA.md from code (kills the co-evolution the spec wants).

**A5. Project identity is the git remote slug, and worktrees/clones deliberately share one
memory.** Evidence this matters: `~/.claude/projects/` on this machine holds separate
directories per worktree (`...--claude-worktrees-agent-<id>`), so a path-derived key would
fragment one project's memory across every agent worktree. *Rejected:* path hash (the
fragmentation just described — this is the spec's own UC3 gate outcome); per-worktree
memory with a merge tool (machinery for a problem the slug removes).

**A6. `initStore` is the exclusive owner of `git init` and of layout creation, and is
idempotent under crash as well as under repeat.** No other module may initialize the store.
*Rejected:* lazy init at each write site (N racing initializers); an install-time script
(the store must survive `rm -rf ~/.mehmory` without a reinstall).

**A7. Distill fixtures are normative — test data is contract.** `test/fixtures/transcripts/`
pairs are the specification of distill behavior; prose describes them, never the reverse.
This makes a bad fixture a permanent bad contract, which is the accepted cost of having any
executable definition of "decision marker" at all. *Rejected:* prose-only definition (the
spec review found "decision markers" undefined and unimplementable); a golden-output
snapshot tool (same contract, worse diffs).

**A8. Fail-open bounds are one protocol, not per-call-site constants.** Every bound (lock
retry 50 × 100 ms, `index.lock` retry 1, queue claim 3, distill loss 10%, log rotation
5 MB, warning 1/hour) is a named key in config with a default, defined in one module.
*Rejected:* literals at each call site (untunable, and the spec's own review found an
unbounded path this way).

**A9. The core library is SYNCHRONOUS at its boundary.** No exported function returns a
Promise. `UserPromptSubmit` has a <100 ms budget and hooks are short-lived processes, so
the async machinery buys nothing and costs a plumbing layer; `node:sqlite`'s `DatabaseSync`
is sync already. *Rejected:* async core (every hook becomes an async entry point for zero
concurrency gain — there is nothing else to overlap with in a hook process); mixed
sync/async (the worst of both, and the boundary would be decided ad hoc in run 2).

**A10. ESM only.** `tsup` emits ESM; hooks are bundled `.mjs`, the CLI is a bundled ESM
binary. *Rejected:* dual CJS/ESM output (two artifacts to test for one consumer set we
fully control); CJS (hooks are `.mjs` per the spec).

**A11. Core never exits the process and never throws across its boundary.** Exported
functions return values or typed errors; `process.exit`/`process.abort` are banned in
`src/core/` by the same eslint mechanism as A3. This is what makes A2's fail-open promise
enforceable rather than aspirational — a library that can exit can kill the harness.
*Rejected:* exit-on-unrecoverable (there is no error worth killing a user's session over).

`docs/WORLD_MODEL.md` does not exist in this repo (verified: `docs/` contains only
`superpowers/`), so A1–A11 contradict nothing and are all **newly established decisions →
ADR candidates**, recorded as ADRs when this run lands. This run creates
`docs/WORLD_MODEL.md` § Architectural Decisions containing exactly A1–A11.

**Irreversibility note on A5 (recorded, not mitigated):** A5 is the one decision that
becomes permanent on contact with a user's disk — once `~/.mehmory/projects/<slug>/`
directories exist, changing the key scheme requires migration tooling or orphans real
memory. The alias map is the escape hatch for merges and splits; there is no cheap reversal
of the scheme itself. Accepted deliberately: the spec's UC3 gate already chose it, and the
evidence for it (worktree fragmentation) is concrete.

## UX

Run 1 ships no CLI, but it fixes the text every later surface prints, so the interface
decision is made here rather than five files later.

**U1. Error text template, with a conditional fix clause.** Errors render as
`MEHMORY E_<CODE>: <what>. <consequence>. [Fix: <command>. ]Details: <errors.log path>`.
Errors are typed at declaration as `actionable` or `informational`. An `actionable` error
carries a real copy-pasteable command; an `informational` one **omits the clause entirely**
rather than inventing advice. The consequence clause is written per-error, not as a blanket
promise. Worked examples, which are the actual test vectors for done-when 5:

- `MEHMORY E_CONFIG_PARSE: config.json is not valid JSON (line 4). Memory is running on
  defaults, so your settings are not applied. Fix: $EDITOR ~/.mehmory/config.json.
  Details: ~/.mehmory/.state/errors.log` — actionable.
- `MEHMORY E_LOCK_TIMEOUT: project lock held for over 5s; proceeded without it. A
  concurrent session may have overwritten an index rewrite. Details: …` — informational,
  no fix clause, because there is no correct user action and `rm`-ing the lock is a wrong
  one.
- `MEHMORY E_DISTILL_LOSSY: 34% of transcript lines were unreadable; that portion of the
  session was not captured. Details: …` — informational.
- Deferred commit (criterion 8) is **not an error at all** and emits nothing; it is normal
  operation that resolves itself on the next call.

The template string is versioned by `FORMAT_VERSION` so a later run can change it
deliberately rather than by drift. *Rejected:* a mandatory `Fix:` clause (forces invented
advice on the three cases above — the reviewer's finding); bare messages (the user cannot
act); a blanket "Claude Code is unaffected" on every error (an unfalsifiable promise baked
into every log line, which a later run cannot walk back).

**U2. Silence is the default; repeated failures surface through the harness, not stderr.**
A Claude Code hook that exits 0 has its stderr effectively swallowed, so a stderr warning is
either invisible or, worse, noise at an unpredictable moment — it fails both audiences.
Instead: core records failures to `errors.log` and maintains rate-limit state in
`.state/warnings.json` (keyed by error code, default 1 per hour, an A8 bound). Core exports
`pendingWarnings()`; run 2's `SessionStart` injects any pending warning as a single line of
its `additionalContext`, which is the one channel both a human and the model actually read.
Run 1 ships the state, the bound, and the API; run 2 wires the consumer. *Rejected:* stderr
(swallowed on exit 0 — the reviewer's finding); doctor-only (the spec's own review found
fail-open can silently disable memory for weeks, and doctor is run 3); warn every time
(per-prompt spam, and the tool gets uninstalled).

**U3. `config.json` is the escape hatch, fully defaulted, and never silently ignored.**
Absent file = working defaults; every key optional; `MEHMORY_HOME` overrides the root. An
unparseable file degrades to defaults **and** raises `E_CONFIG_PARSE`, which is
`actionable` and enters the U2 pending-warning channel — so the user who edited the file
finds out, without a crash. Failing loud by exiting is not available to us: fail-open is
non-negotiable for hooks. *Rejected:* silent fallback (the user edited a file and got
nothing — the reviewer's finding); hard failure on bad config (breaks the harness over a
typo); required config (a setup step before the tool works).

Intended users: a Claude Code power user reading an error in a terminal, and an agent
reading the same text as a tool result. One deterministic string serves both **because it
travels one channel** — `errors.log`, surfaced via SessionStart context. The earlier draft's
claim that one string served both while travelling stderr was wrong: agents never see
stderr.

**Discoverability across runs 1–2 (recorded).** Run 1 wires no hooks, so it cannot silently
fail for a user — nothing calls it yet. The week-of-silence scenario becomes real in run 2,
and U2's pending-warning channel is what covers it there; `doctor` (run 3) is the full
sweep, not the first line of defence.

## Subtasks

Stream A is a hard blocker on every other stream; B–F are independent once A lands.

- **A — scaffold + error taxonomy + module skeleton.** `package.json` (pnpm), `tsconfig`
  (strict, no `any`), vitest, eslint + prettier, tsup (ESM output), husky pre-commit
  running lint + test, `AGENTS.md`, `docs/WORLD_MODEL.md` with A1–A11, and
  `src/core/errors.ts` (typed errors with `actionable`/`informational` kinds, `E_<CODE>`
  registry, `formatUserError`, `failOpen`, `errors.log` writer with 5 MB rotation,
  `recordWarning`/`pendingWarnings` over `.state/warnings.json`). A also writes the four
  custom lint rules the architecture decisions depend on: the A3 `node:fs` import ban
  outside `src/core/fs.ts`, the A11 `process.exit` ban, the A9 no-exported-Promise rule,
  and the U2 no-stderr rule. **A declares every dependency B–F will need up front**, so no
  later subtask edits `package.json` — that file is the one real merge-conflict surface in
  this decomposition and A owns it exclusively. A exports typed stubs for B–F so they never
  touch each other's files. → done-when 1, 2, 5, 15, 17, 18, and A1/A2/A8/A9/A10/A11/U1/U2.
- **B — identity + config.** `resolveProjectKey`, `loadConfig`, defaults, `MEHMORY_HOME`,
  alias map. → done-when 3, 4, A5, U3.
- **C — fs primitives.** `atomicWrite`, `appendRecord` (single-line invariant + 4 KiB
  ceiling), `withProjectLock`, `commitPaths` git wrapper, durable job queue
  (`enqueueJob`/`claimJob`). → done-when 6, 7, 8, 9, A3.
- **D — transcript + distill + cursor.** JSONL reader tolerant of the heterogeneous record
  types actually present (`mode`, `file-history-snapshot`, message records), enumerated
  distill patterns, stable entry IDs, cursor with rotation/truncation handling, normative
  fixtures. → done-when 10, 11.
- **E — secret filter + token cap.** `redact` + corpus fixtures, `estimateTokens`,
  `buildInjection` with the 200/200/400 allocation, truncation order, and the data-only
  frame applied last. → done-when 12, 13.
- **F — schema split + store init.** `src/schema/format.ts` (incl. the versioned error
  template), `assets/SCHEMA.md`, `initStore` (layout, git init, idempotent under repeat and
  under crash). → done-when 14, 16, 19, A4, A6.

Unlock condition for B–F: A merged into the run branch (not into `main`).

## Dispatch shape

`swarm` — six units, one serial blocker (A) then five genuinely independent streams that
touch disjoint files. Solo would serialize five parallelizable units behind one context.

## Spec gaps and inferences

Each entry is a decision the spec did not make. All are **spec amendments** applied to
`docs/superpowers/specs/2026-07-28-mehmory-design.md` as part of this run's landing (a
`## Run-1 amendments` section), not silent inferences. Items 1–8 resolve findings from the
spec-stage adversarial review.

1. **Injection allocation (resolves BLOCKER: 200+200+500=900 > 800).** Authoring caps and
   injection allocations are different things. Authoring caps stay as specced; injection
   allocates identity 200 / project 200 / index 400 = 800, truncating in the spec's stated
   priority order. Identity is never dropped entirely.
2. **Record atomicity (resolves MAJOR: O_APPEND interleave).** Every inbox/log/stats record
   is exactly one `\n`-terminated line written in one `write()`; embedded newlines are
   JSON-escaped. Documented ceiling: 4 KiB, above which the lockfile path is used.
3. **`index.lock` defer bound (resolves BLOCKER: unbounded defer).** Retry once after
   100 ms; then leave staged and return `deferred: true`. The next `commitPaths` commits
   the accumulated paths — bounded because deferral accumulates no queue. `doctor` (run 3)
   flags a tree dirty across sessions.
4. **Queue claim protocol (resolves BLOCKER: undefined durability).** Claim by atomic
   `rename()` into `queue/claimed/`; stale claims reclaimable by mtime; 3 failed claims →
   `queue/failed/`.
5. **Concurrent-session decay race (resolves BLOCKER).** Index rewrites and decay run under
   `withProjectLock`; lock acquisition is itself fail-open after a bounded wait.
6. **Cursor rotation/truncation (resolves MAJOR).** Cursor carries `dev:ino` and `size`;
   rotation or truncation resets the offset, and stable entry IDs make replay a no-op.
7. **Worktree/clone identity fork (resolves BLOCKER: left OPEN in the spec).** Clones and
   worktrees of one remote share one memory, deliberately. Alias map overrides.
8. **`pointers-followed` KPI (resolves MAJOR: self-contradiction).** Removed from the v1
   KPI table; `pointers_offered` remains as the measurable proxy. Spec addendum item 14 is
   amended to match item 22.
9. **Toolchain not specified by the spec:** pnpm, vitest, tsup, eslint + prettier, husky —
   chosen per the host's standing conventions.
10. **`ephemeral` staleness threshold** is deferred to run 2 with the integrate skill that
    owns it; run 1 only defines the `decay` frontmatter class constants. Recorded so it is
    not lost.
11. **FTS5 availability** was an open question in the review and is now **measured, not
    inferred:** `node:sqlite` on Node 22.22.3 / SQLite 3.51.3 builds `fts5` with both
    `porter unicode61` and `trigram` tokenizers (command:
    `node -e` script run at intake, both queries returned 1 row). No spec change needed;
    recorded as evidence for run 3.

Entries 12–16 were added after plan-stage review; they are decisions the spec never made
and that runs 2–3 cannot add later without breaking run 1's contracts.

12. **Sync/async boundary (A9):** the core is synchronous. The spec sets a <100 ms
    `UserPromptSubmit` budget but never says what shape the library has; deciding it in
    run 2 would mean rewriting run 1's exports.
13. **Module format (A10):** ESM only. The spec says hooks are bundled `.mjs` but never
    states the library's output format.
14. **Process-exit ban (A11):** the spec promises hooks "fail open" but places no constraint
    on the library that would make it true. Now a lint-enforced ban.
15. **Warning channel (U2):** the spec's addendum item 23 says repeated failures emit "a
    rate-limited one-line stderr warning". Amending: stderr is swallowed for a hook exiting
    0, so the warning travels `errors.log` + `pendingWarnings()` + SessionStart context
    instead. This **changes a contract the spec fixed** and is therefore raised explicitly
    at the gate rather than absorbed — accepting the plan accepts this amendment.
16. **Conditional `Fix:` clause (U1):** the spec's addendum item 27 mandates a `Fix:`
    clause on every surfaced error. Amending: errors with no correct user action omit it
    rather than inventing advice. Same status as 15 — a contract change, raised at the gate.

## Envelope

- `dispatch_budget`: **12** — 6 execution workers (A–F), 1 verifier, up to 2 fix attempts,
  2 reserved for landing-stage review findings + re-verify, 1 spare.
- `usage_budget_hours`: **3**.
- Intake-charged (not counted above): 4 review dispatches — spec adversary, contract,
  architecture, UX. All 4 spent.
- Experiments: 0 used, 2 available.

## Stages

- **Intake depth:** ambient (crisp — the idea derives from an approved spec). Two
  confirming questions asked: run slicing, envelope. Author checklist run; artifact
  enumeration recorded below.
- **Architecture design:** `fired` — clauses 1 (new modules owning behavior), 2 (new
  composition edges core↔hooks↔CLI), 3 (shared abstractions), 4 (newly establishes entries
  in a `docs/WORLD_MODEL.md` that does not yet exist).
- **UX design:** `fired` — clause 1 (error text a human reads; `config.json` keys).
  Clauses 2 and 3 evaluated false (no trigger phrase, no interactive steps in run 1) but
  clause 1 alone fires the stage.
- **Design review:** `fired` at both stages, all four dispatches complete before the gate.
  Spec stage: 22 findings (6 BLOCKER / 9 MAJOR / 4 MINOR + 1 measured PASS), triaged into
  Spec gaps 1–11. Plan stage: contract PASS (0 findings, evidence trail checked under
  zero-finding scrutiny); architecture FAIL (3 silent decisions, 5 missing commitments);
  UX FAIL (5 findings). One amendment round applied, exactly the reviewers' proposed
  fixes → verdicts carry forward bound to plan+amendments, no re-review. Evidence in
  `## Design review` below.
- **Experiment stage:** not fired — no contested finding after a debate round, no
  hold-my-beer declared, no user ask. The one empirically-decidable question (FTS5
  tokenizers) was settled by a 2-minute local command, not a dispatch.
- **Dispatch shape:** swarm, 6 units, 1 serial blocker.
- **Verification:** fresh verifier bound to the blessed swarm branch, briefed with the 16
  done-when criteria; swarm unit verdicts are inputs, not substitutes.
- **Landing:** `auto-land`.

### Author-time checklist

1. *Cross-artifact consistency:* run 1 ships no script/prose pair — no CLI, no exit codes.
   The library's externally observable behaviors are the 19 done-when criteria; each maps
   to a subtask (A→1,2,5,15,17,18; B→3,4; C→6,7,8,9; D→10,11; E→12,13; F→14,16,19) and
   every subtask maps back to at least one criterion. No orphans in either direction.
2. *State-machine completeness:* two enums appear. **Queue job:** `queued` (entry: enqueue)
   → `claimed` (entry: rename; exit: applied or stale-reclaim back to `queued`) → `applied`
   (terminal) | `failed` (terminal, after 3 claims). **Cursor:** `fresh` → `advanced`
   (entry: complete record parsed) → `reset` (entry: `file_id` change or `size < offset`;
   exit: back to `advanced`). Both have entry and exit paths for every non-terminal state.
3. *Loop-bound rule:* lock retry 50 × 100 ms then proceed lock-free; `index.lock` retry 1
   then defer with no accumulating queue; queue claim 3 attempts then `failed`; distill
   skips lines with a >10% warning threshold; log rotation at 5 MB keeping 1 generation;
   stderr warning at most 1/hour/code; verify fix loop capped at 2 by the skill. No
   unbounded loop.
4. *Why shouldn't we do this?* Run 1 lands zero user-visible value — a library nobody calls
   yet. If runs 2–3 never happen, this merge is dead code. Mitigation: the slicing is the
   user's explicit choice, and the alternative (one 40-file run) trades this risk for a
   worse one. Second downside: contracts frozen now constrain runs 2–3; if run 2 finds a
   primitive wrong, that is a pivot back to the design loop, not a patch.
5. *What goes wrong when we do this?* (a) The concurrency tests are the most likely place
   to be quietly wrong — a passing test that never actually races. Mitigated by requiring
   real concurrent *processes* in criteria 6 and 9, not `Promise.all` in one process.
   (b) The distill fixtures are normative, so a bad fixture becomes a permanent bad
   contract; mitigated by deriving fixtures from real transcripts under
   `~/.claude/projects/`, redacted. (c) chars/4 token estimation may be off enough that the
   800-token cap is really 960; the ±20% tolerance is documented rather than hidden.
6. *Artifact enumeration:* greps run at intake —
   `git ls-files | grep -vE '^docs/'` → `.gitignore` only;
   `grep -rlnE 'package\.json|tsconfig|src/|SCHEMA\.md|config\.json|\.mehmory' --include='*.md' .`
   → the design spec only; `ls ~/.mehmory` → does not exist; `which mehmory` → no
   collision. Every hit is covered by the File-changes implied by subtasks A–F (the spec is
   edited by the Spec-gaps amendment; `.gitignore` gains `node_modules/`, `dist/`, and
   `/.deliver/SESSION.md`). No unaccounted hits.

## Open decisions

None.

---

Run file: .deliver/runs/2026-07-29-mehmory-foundation.md   (read this first — it holds the ledger)
Branch: create `feat/foundation`
Envelope: 12 dispatches
Resuming: this is a deliver-idea run at step 4; approval was granted by the click that
produced this message.

## Execution ledger

**Dispatches used: 7 of 12** (6 workers A–F, 1 verifier). Fix cycles were handled as
messages to live workers, not new dispatches. Branch `feat/foundation`, 9 commits, signed.

Gate on final state: `pnpm build`, `pnpm lint`, `pnpm exec tsc --noEmit` all exit 0;
`pnpm test` 190 passed / 18 files.

**Every worker reported "done" against a red or hollow gate at least once.** The plan's
choice to require an independent verifier rather than trust worker verdicts was correct;
the verifier itself then went idle without producing a report, so the lead performed the
break/restore verification directly.

### Defects caught after a worker reported green

- `require()` inside an ESM module made **log rotation unreachable**, swallowed by its own
  `catch`. Rotation had never run.
- `recordWarning` appended JSON documents to a JSON file, so **rate limiting broke
  permanently after the first call** and `pendingWarnings()` silently returned `[]`.
- Subtask A created 12 throwing stub files inside B–F's territory, 3 at wrong paths.
- **No fixture tests existed for any of the four custom lint rules** (criterion 18).
- Three `throw` statements in `src/core/` violated A11; the lint rules do not cover throws,
  so they rode through a green gate. `appendRecord` additionally threw when a >4 KiB record
  arrived without the optional lock argument.
- **`DECAY_CLASSES` shipped invented values** (`stable`, `permanent`) contradicting the
  spec's own gate outcome (`evergreen | ephemeral | default`), propagated into `SCHEMA.md`
  and `store.ts`, with a test asserting the invented ones. Run 2 parses these.
- The **normative distill fixtures were dead** — nothing loaded them — while their README
  asserted they were the contract. Expected `id` values were the literal string
  `"sha256(...)"` rather than digests.
- Tests that shell out to git **failed inside a pre-commit hook**, because git exports
  `GIT_DIR`/`GIT_INDEX_FILE` to hooks and the tests inherited the outer repository's index.
  Only reproducible when committing, which is how CI will run them.
- `eslint.config.js` spread `tseslint.configs.strictTypeChecked[0].rules` — `[0]` is the
  `base` config with **zero rules**, so the headline strictness applied nothing.
- `JSON.parse` results were assigned into typed variables in `errors.ts`, `queue.ts` and
  `reader.ts`, admitting implicit `any` on exactly the paths that read untrusted data
  off disk.

### Break/restore verification (the load-bearing criteria)

Each implementation was deliberately broken, the test observed, then restored.

| Criterion | Break applied | Test went red |
|---|---|---|
| 6 — append atomicity | split the single `write()` into two | yes |
| 9 — queue exclusivity | non-atomic claim, 50 ms race window | yes, **after** the barrier fix |
| 10 — cursor rotation | removed rotation reset | yes |
| 10 — cursor truncation | removed truncation reset | **no — test was hollow**, now fixed |
| 10 — full replay | made distill ids unstable | **no — test never ran distill**, now fixed |
| 11 — normative fixtures | tampered expected output | yes |
| 14/19 — store idempotency | removed user-file guard | yes |
| A3/A9/A11/U2 lint rules | probe file with all four violations | yes, all four fired |

Three tests passed against deliberately broken implementations and were rewritten:

1. **Criterion 9's 5-claimer test** passed for three rounds against a non-atomic claim. Its
   barrier released on a 100 ms timer, so any worker whose node boot outlasted the timer
   found the flag already set and never waited — the claims never overlapped. Replaced with
   a two-phase barrier: workers announce ready and block; the parent releases only once all
   five report, with a deadline that fails the test if they do not.
2. **Criterion 10's truncation test** passed `newOffset=0` then asserted offset was 0 — true
   regardless. It also shrank the file with `atomicWrite`, which replaces via temp+rename,
   so the inode changed and the *rotation* branch fired first; the truncation branch was
   unreachable. Now truncates in place, as real transcripts are.
3. **Criterion 10's replay test** asserted only that cursor state was unchanged, which holds
   even if distill emits duplicates every pass. Now runs read+distill twice and asserts zero
   new ids. Its records also matched no distill pattern, so distill returned `[]` and
   "zero new entries" was true for the wrong reason.

A negative control must not be able to self-correct. An early attempt at criterion 9 had
workers write a claim then fail `remove()` on an already-deleted file, routing them into a
`catch` and producing exactly one apparent winner from a broken implementation.

### Deferred to run 2 (recorded, not silently dropped)

- **Full `strictTypeChecked` adoption.** The corrected spread flags **161 issues** across
  `src/` and `test/`. Run 1 enforces `eslint-recommended` plus an explicit `no-explicit-any`
  + `no-unsafe-*` family scoped to `src/`, which is what criterion 2 requires. The remaining
  are mostly `restrict-template-expressions` and are run-2 work.
- **`test/lock.test.ts` sleeps ~5 real seconds** to assert the 50 × 100 ms retry bound —
  about 10 s of suite time and load-sensitive. Should assert the arithmetic with an
  injected small retry count before run 3 wires CI.
- **`handles mid-line truncation at EOF`** still passes `newOffset=0` explicitly. The
  behaviour it names is covered by the rewritten truncation test; the tautology remains.

## Design review

Four dispatches, all pre-gate, all intake-charged. One amendment round, applied as exactly
the reviewers' proposed fixes.

**Spec stage — chaos-engineer adversary vs. the approved spec.** FAIL: 22 findings
(6 BLOCKER / 9 MAJOR / 4 MINOR). Blockers: injection arithmetic (200+200+500 > 800);
project identity stale in the spec body vs. the UC3 gate; SessionEnd queue durability
undefined; `index.lock` defer unbounded; concurrent-SessionStart decay race; worktree/clone
identity fork left OPEN. Resolution: all 6 blockers and 5 of the majors became Spec gaps
1–8 (each a spec amendment landing with this run). One finding — the claim that
`node:sqlite` FTS5 with porter+trigram might be unavailable — was **refuted by measurement**
rather than debated (Spec gap 11), which is why the experiment stage did not fire.

**Plan stage — contract reviewer.** PASS, 0 findings. Held to zero-finding scrutiny: the
verdict shows its work (bidirectional criterion↔subtask mapping enumerated, both state
machines walked, each named bound traced to an asserting criterion, one enumeration grep
re-run independently), so it is a strong pass, not a weak attack. It did miss one thing the
architecture review's file-conflict lens caught indirectly — `package.json` contention
across parallel subtasks — now closed by giving subtask A exclusive ownership of it.

**Plan stage — architecture reviewer.** FAIL. (2) three load-bearing decisions established
silently → now named A6 (`initStore` owns git init), A7 (fixtures are contract), A8
(fail-open bounds are one protocol). (4) A5 flagged as irreversible once user directories
exist → recorded as an explicit irreversibility note rather than pretended away. (5) five
structural commitments undecided that runs 2–3 cannot add later → now A9 (sync boundary),
A10 (ESM), A11 (no process-exit), plus `commitPaths` accumulation semantics in criterion 8
and crash-recovery idempotency in criterion 19. Checks 1 and 3 PASS (WORLD_MODEL absence
verified independently; alternatives judged real, with A1's plugin-seam rejection and A4's
code-gen rejection called out as the thinnest — accepted at plan stage).

**Plan stage — UX reviewer.** FAIL, 5 findings, 4 accepted and 1 partially. (1) the
mandatory `Fix:` clause forces invented advice on `E_CONFIG_PARSE`, `E_LOCK_TIMEOUT`,
`E_DISTILL_LOSSY` → clause is now conditional on an error's declared kind, with the
reviewer's own four cases promoted to test vectors. (2) stderr is the wrong channel (a hook
exiting 0 has stderr swallowed, and agents never see it, which falsified the plan's
one-string-two-audiences claim) and the rate-limit state had no defined storage → replaced
by `.state/warnings.json` + `pendingWarnings()` + SessionStart injection in run 2. (4)
silent config degradation → now degrades *and* raises an actionable warning; failing loud
by exiting stays rejected because fail-open is non-negotiable. (5) template locked-in
wording → template versioned by `FORMAT_VERSION`, blanket "Claude Code is unaffected"
dropped for per-error consequences. (3) run-1 discoverability without `doctor` — accepted
in part: the finding is real for run 2 and is covered there by the U2 channel, but run 1
wires no hooks and so cannot silently fail for a user; recorded rather than treated as a
run-1 blocker.

**Two amendments change contracts the spec fixed** (Spec gaps 15 and 16: the stderr channel
from addendum item 23, and the mandatory `Fix:` clause from addendum item 27). Under the
design-review rules a gap that changes a contract escalates rather than being absorbed, so
both are named here and at the gate: approving this plan approves those two spec amendments.
