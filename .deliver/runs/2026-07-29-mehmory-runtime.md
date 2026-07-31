# Run: mehmory-runtime

mode: single
approved: 2026-07-29 (rev 1, incl. gate-raised contract changes: spec gaps 2, 10, 14)
retroed: 2026-07-31T15:10:00Z
case_studied: 2026-07-30T12:35:00Z
session: 953569ee-46a4-486c-ace4-5d53104f635b
model: claude-fable-5
context_at_approval: same session as intake; plan frozen before the gate

Dispatches: 9 of 11 (execution envelope; intake-charged: 4 of 4 spent)

## Approved plan (rev 1)

# Plan: mehmory-runtime

Run 2 of 3 delivering `docs/superpowers/specs/2026-07-28-mehmory-design.md` (approved v1,
all-in). Slicing chosen by the user at run-1 intake: run 1 foundation (landed, PR #1),
**run 2 hooks + skills + plugin packaging (this plan)**, run 3 CLI surface + docs + CI.
Two intake confirmations this run: (a) UserPromptSubmit ships grep-only full-text matching
in run 2 — the spec's own fallback path — with the FTS index arriving in run 3; (b) run 2
absorbs the debt run 1 explicitly deferred to it, plus retro promotions P5 and P6.

## Problem

The foundation library is merged but nothing calls it: no hook fires, no skill exists, and
installing the repo changes nothing about a Claude Code session. Every user-visible promise
of the spec — capture, injection, integrate — requires the 5 hooks, the 4 skills, and a
plugin package that wires them in. Additionally, run 1 recorded debt explicitly assigned to
run 2 (full `strictTypeChecked` — 161 flagged issues; `tsc --noEmit` missing from the
pre-commit gate, which let a non-compiling branch pass four gates; two hollow-test
remnants), and the spec-stage adversary for this run found 3 blockers in the spec's run-2
surface (PreCompact block is impossible under the real hook contract; the capture cursor is
a global singleton where the spec requires per-session offsets; inbox.md serialization is
undefined yet four specced behaviors parse it) that must be resolved as spec amendments
before implementation.

## Done when

Each criterion is checkable by a command a verifier runs itself. All hook tests are
stdin/stdout fixture tests against the **built** `hooks/*.mjs` artifacts (spawn `node
hooks/<name>.mjs` with fixture stdin, assert stdout JSON and exit code), run against a temp
`MEHMORY_HOME` — the spec's integration-test contract. Every hook has at least one
**positive-path** fixture (adversary MINOR: an all-no-op hook set is letter-compliant) and
at least one fail-open fixture.

1. **Gates:** `pnpm install && pnpm build && pnpm lint && pnpm test && pnpm typecheck` all
   exit 0 from a clean clone. `.husky/pre-commit` runs lint, test, **and** `tsc --noEmit`
   (retro P5); the probe is scripted, not narrated — the **verifier itself** commits a
   `.ts` file with a type error on a temp branch, asserts the hook rejects it with
   non-zero exit, and cleans up (a ledger paragraph is not evidence).
2. **strictTypeChecked:** `eslint.config.js` applies the full `strictTypeChecked` rule set
   (spread correctly, not `[0]`) across `src/` and `test/` with zero violations and zero
   new `eslint-disable` comments beyond ones individually justified in-line; the run-1
   `no-explicit-any`/`no-unsafe-*` family stays. The two run-1 test remnants are gone:
   `test/lock.test.ts` asserts the retry bound via an injected small retry count (no ~5 s
   real sleep; suite wall time drops accordingly), and the tautological
   `handles mid-line truncation at EOF` assertion is replaced or removed.
3. **Plugin layout:** `.claude-plugin/plugin.json` (name `mehmory`, version from
   `package.json`), `hooks/hooks.json` registering exactly 5 hooks (SessionStart with
   `startup|resume|compact` matchers, UserPromptSubmit, Stop, PreCompact, SessionEnd)
   pointing at bundled self-contained `hooks/*.mjs` files, and
   `skills/{integrate,lint,onboard-session,remember,pause,resume}/SKILL.md`. A test
   validates hooks.json event names against the plugin schema, that every referenced
   `.mjs` exists after `pnpm build`, and that each runs standalone from a directory
   **outside** the repo (no `node_modules` resolution — bundle is genuinely
   self-contained).
4. **Inbox entry format (resolves spec blocker 3):** `src/schema/format.ts` exports the
   normative single-line entry serialization — `- <text> <!--mehmory id=<sha256-16>
   src=<sessionId> ts=<iso8601>-->` — with `serializeInboxEntry()`/`parseInboxEntries()`
   round-trip tested, embedded newlines JSON-escaped per the run-1 `appendRecord` contract.
   `appendInboxEntries()` skips entries whose `id` already exists in the file (replay
   no-op); `snapshotClearInbox()` runs under `withProjectLock` (skill path — the full
   50 × 100 ms retry is permitted here, unlike the hook maintenance lane) and removes
   exactly the snapshotted entry lines — a test appends a concurrent entry between
   snapshot and clear and asserts it survives (spec addendum 15's "inbox is never lost"
   under concurrency). Known, recorded weakening: dedup is by id-in-file, so after an
   integrate clears the inbox, a cursor reset can re-introduce old entries — replay is a
   no-op *until the next integrate*, whose editorial merge absorbs duplicates (spec gap
   21).
5. **Session-scoped capture state (resolves spec blocker 2):** per-session state lives in
   `.state/<session-id>.json` (spec line 78) carrying the capture cursor, Stop counter,
   topic cache, cached project key, and pause flag. Two interleaved sessions capturing
   from different transcript files never reset each other's cursor (test simulates the
   run-1 blocker scenario: alternating A/B captures, asserts no offset reset and no
   re-distill). Corrupt session state resets to fresh + `errors.log` entry, never throws
   (spec review change 3). Stale session-state files are swept by the SessionStart
   maintenance pass after `session_state.max_age_days` (default 14; A8-style named bound);
   SessionEnd deletes its own.
6. **Stable IDs on resume (resolves spec MAJOR):** distill entry IDs key on the
   **record-embedded** `sessionId` field, not the invoking hook's `session_id`; a resume
   fixture (new session id, transcript containing prior-session records with original
   embedded sessionIds) produces zero duplicate inbox entries.
7. **SessionStart:** given a populated store, stdout `additionalContext` contains the
   data-framed identity/project/index injection (run-1 `buildInjection`, ≤800 tokens) plus
   **at most 2 maintenance lines**, chosen by priority: pending warning (run-1 U1
   template, wiring U2 / spec amendment 15) > compact notice > integrate nudge > init
   notice. Nudge fires when inbox ≥ threshold (entries counted via `parseInboxEntries()`,
   `inbox.nudge_entries` default 10 or `inbox.nudge_bytes` default 8192). The `compact`
   matcher's notice names the inbox path and the `/mehmory:integrate` invocation
   (replacing the impossible PreCompact block, spec blocker 1). A worst-case fixture
   (warning pending + compact + nudge simultaneously) asserts exactly 2 maintenance lines
   emitted and **combined output ≤ 950 estimated tokens** (800 wiki + 150 maintenance —
   enforced, not documented-only). An initialized-but-unpopulated store still injects at
   least the identity frame plus an onboarding pointer line, so total silence stays
   reserved for paused or failed (U7's verifiable-by-absence). Fixtures: populated,
   initialized-empty, nudge, warning, compact, worst-case stack.
8. **First-run auto-init (resolves spec MAJOR):** SessionStart with no store present calls
   the run-1 idempotent `initStore()` (A6 preserved — `initStore` remains the sole owner)
   and injects a one-line notice naming the store path **and the next step** ("run
   /mehmory:onboard-session to seed it") — a path alone gives a fresh user nothing to do,
   and run 2 ships no docs. No hook ever prints the run-3 `mehmory init` hint.
9. **SessionStart maintenance is best-effort and bounded:** the decay pass (recency
   re-sort, >60d demote below Archive divider, >90d move to `archive/`, `default` decay
   class only) runs under `withProjectLock` and is **skipped entirely** when the lock is
   not acquired on the first attempt (never the 5 s retry loop on the injection path);
   at most `queue.claims_per_start` (default 1, A8-style named bound — run 3 raises it
   without amending an ADR) queued jobs are claimed per invocation. Tests: decay ops on
   fixture pages with aged `updated` frontmatter; lock-held fixture asserts injection
   still emitted and decay skipped.
10. **UserPromptSubmit:** grep-based full-text match of prompt terms over page bodies +
    titles returns at most 3 pointer lines (`relevant: pages/<name>.md`) as
    `additionalContext`; no match → empty stdout, exit 0. Topic-stability cache: Jaccard
    similarity ≥ 0.7 against the cached prompt token set within a 5-min TTL skips the
    lookup (both constants config-named). `remember: <text>` prefix (gate T2) appends the
    redacted text to inbox via the entry format and returns an
    `additionalContext` acknowledgement line — prompt passes through unmodified
    (UserPromptSubmit cannot rewrite prompts; resolves spec MAJOR). **Warning-drain
    fallback (UX finding):** when the last SessionStart stats entry for this project is
    absent or stale, UserPromptSubmit drains one pending warning line — otherwise a dead
    SessionStart hook is both the failure and the only channel that would report it.
    Fixtures: match, no-match, cache-hit, `remember:` capture incl. a secret that must be
    redacted, warning-drain with stale SessionStart stats.
11. **Stop:** increments the session counter per invocation; `stop_hook_active: true` in
    stdin → exit 0 immediately, no increment, no block (loop guard). At counter ≥ 15
    since last capture: distill transcript delta from the session cursor → append to
    inbox → reset counter → emit `decision: block` with a bounded reason instructing the
    model **once** — "once" = once per threshold crossing (resolves spec MAJOR). Counter
    resets on **any capture in this session: Stop-threshold or PreCompact** (the
    SessionEnd job targets a session whose state file is already deleted, so it resets
    nothing — contract-review fix). The block reason embeds the concrete executable
    action — the `node <hook-dirname>/inbox-tx.mjs append` invocation (the hook knows its
    own dirname) or `/mehmory:remember` — **never the raw serialization format**: a model
    cannot compute `id=<sha256-16>` by hand, and raw appends violate A15. Fixtures: below
    threshold (silent), at threshold (captures + blocks, reason contains the helper
    invocation), stop_hook_active (no-op), post-capture next stop (silent — no period-2
    re-block), PreCompact-then-Stop (counter was reset — silent).
12. **PreCompact:** deterministic distill of everything since the last capture, appended
    to inbox; **no block, no stdout decision** (spec blocker 1 amendment — the model-facing
    notice moved to SessionStart(compact)). Fixture asserts inbox delta and empty decision.
13. **SessionEnd:** enqueues a durable `distill-final` job (run-1 `enqueueJob` with
    `_jobType`), appends the log entry, commits via `commitPaths`, deletes its own session
    state file, exits. The next SessionStart claims and applies the job (test: SessionEnd
    fixture then SessionStart fixture, asserts distilled entries present and job in
    neither `queue/` nor `claimed/`).
14. **Secret filter at every hook write boundary:** transcripts and `remember:` text pass
    through run-1 `redact()` before any inbox write; a fixture with an AWS key in a
    transcript record and one in a `remember:` prompt asserts neither reaches inbox.
15. **Fail-open everywhere:** for each of the 5 hooks, a fixture with (a) corrupt session
    state, (b) unreadable/absent transcript, (c) a store path that is a file not a
    directory, and (d) a corrupt store `.git` (persistent `commitPaths` failure) exits 0
    with well-formed (possibly empty) stdout and an `errors.log` entry. No hook writes to
    stderr — the run-1 U2 lint rule extends to the **five hook entrypoints**;
    `inbox-tx.ts` is exempt: it is a CLI-shaped helper invoked via Bash and legitimately
    uses stderr + non-zero exit to report a failed transaction to the invoking model.
16. **Instrumentation:** every hook invocation appends one stats.jsonl line
    `{ts, project: <key slug>, hook, ms, injected_tokens?, pointers_offered?,
    inbox_bytes?, captured_entries?}` (field `project` is the resolved project key, not a
    path-hash — spec MINOR fix) via the run-1 append/rotation protocol (5 MB, A8). A test
    asserts line shape per hook and that `ms` is present. Latency **budgets** are
    documented as amended (criterion 18) and measured via stats — not asserted as wall
    time in CI.
17. **Skills:** each SKILL.md has `name`, `description`, and `allowed-tools` frontmatter;
    `integrate` instructs snapshot-clear via the bundled transactional helper
    `hooks/inbox-tx.mjs` (never raw model Edit for the clear step — spec MAJOR), covers
    supersession-as-editing, `[[links]]`/index/frontmatter upkeep, ephemeral
    refresh-or-delete, provenance `refs`, log entry + commit, **and appends its own
    stats.jsonl line (`entries_integrated`, `pages_touched`) as part of the log-entry
    step — spec Instrumentation section; `lint` likewise** (contract-review orphan fix);
    `lint` is report-first, apply-on-approval; `remember` appends via the helper and its
    `description` **names the `remember:` prompt prefix** (the only run-2 surface that can
    teach it); `onboard-session` is defined (spec MAJOR) as in-session onboarding —
    survey the current project (README, manifest, git log, docs), seed project.md +
    initial pages + index per SCHEMA.md, commit; `pause`/`resume` flip the capture switch
    (DX item 30): the session flag **only ever disables** — `resume` clears the session
    flag and never re-enables a config-disabled hook (precedence fix). A test validates
    frontmatter presence and that every script path a SKILL.md references exists
    post-build. `hooks/inbox-tx.mjs` (bundled, tested directly) exposes `snapshot`,
    `clear <snapshot-id>`, `append` subcommands over the criterion-4 primitives.
18. **Spec amendments landed:** the spec gains `## Run-2 amendments` and
    `docs/WORLD_MODEL.md` gains the run-2 entries (ADR candidates A12–A16 below +
    amendment list), including the amended latency budgets: SessionStart <1 s applies to
    the injection path with maintenance best-effort; UserPromptSubmit budget restated as
    <100 ms in-hook work, end-to-end target <300 ms including process spawn, both
    measured via stats (spec MAJOR — the original <100 ms end-to-end is unmeetable with
    node process startup alone).
19. **Capture toggles:** hooks honor per-hook config toggles (`hooks.<name>.enabled`,
    default true) and the session pause flag; precedence session > project > global.
    Fixture: paused session produces no capture and no injection beyond fail-open
    behavior. (Config keys already defaulted per run-1 done-when 4; this wires them.)
20. **AGENTS.md** updated: run-2 directory structure (`src/hooks/`, `hooks/`, `skills/`,
    `.claude-plugin/`), subtask ownership, and the retro-P6 pointer to gitignored working
    directories (`.work/`, `.research/`, `.swarm/reports/` hold run evidence a fresh
    session should know exists).
21. **Hermetic tests:** nothing reads or writes `~/.mehmory` or `~/.claude` (run-1
    test-setup guard extended to hook fixture tests, which spawn subprocesses — guard
    asserts on the subprocess env too).

## In scope / Out of scope

**In scope:** the 5 hooks (`src/hooks/*.ts` → bundled `hooks/*.mjs`), `hooks/hooks.json`,
`.claude-plugin/plugin.json`, the 6 skill files, the `inbox-tx.mjs` helper, library
extensions the hooks need (inbox entry format, session-scoped state incl. cursor, decay
file ops, stats writer, grep matcher, topic cache), the run-2 spec amendments, the run-1
deferred debt (strictTypeChecked, pre-commit tsc, two test cleanups), retro P5/P6, AGENTS.md.

**Out of scope:** every CLI command incl. `search`/`doctor`/`onboard`/`purge` (run 3); the
FTS index and its SessionEnd rebuild job (run 3 — grep-only matching this run); marketplace
publishing, README/quickstart/troubleshooting docs, CI workflow (run 3); the dogfood eval
harness (not v1 CI); embeddings/MCP/team features (spec non-goals). Installing the plugin
into the user's live Claude Code config is **not** part of landing — the run delivers the
package; the user opts in.

## Architecture

**A12. Hooks are thin adapters; every behavior lives in `src/core|schema|distill`.** Each
`src/hooks/<name>.ts` parses stdin JSON, calls library functions, serializes stdout JSON —
no business logic, upholding run-1 A1 (library, not framework). The eslint boundary rules
(A3 fs-ban, A9 sync, A11 no-exit, U2 no-stderr) extend to `src/hooks/`. *Rejected:* logic
in hook files (untestable except via subprocess, and run 3's CLI would duplicate it);
one mega-hook script with a mode switch (five registrations exist in hooks.json anyway;
a shared-core-five-entrypoints bundle gets the same dedup without the dispatch layer).

**A13. Capture state is session-scoped: one `.state/<session-id>.json` per session holds
cursor, counter, topic cache, cached project key, pause flag.** This amends run 1's global
`cursor.json` contract — recorded as a run-2 amendment, and the global-cursor API is
removed rather than kept alongside (one way to do it; nothing shipped consumes it yet, so
the break is free now and expensive after run 3). *Rejected:* global cursor (spec blocker:
interleaved sessions reset each other into full re-distill); separate files per concern
(cursor.<id>, topics.<id>, … — N files to sweep and corrupt independently); keying by
transcript path instead of session id (resume copies transcripts; session id is the stable
handle the hook actually receives).

**A14. Inbox entries are a code-owned single-line format (extends A4).** Serialization
lives in `format.ts` with parse/serialize round-trip; text is human-readable markdown, the
trailing comment carries machine identity. *Rejected:* freeform markdown bullets
(snapshot-clear and dedup become heuristics — the spec blocker); a sidecar index file
(two artifacts that drift; the inbox is supposed to be self-contained and human-editable);
JSON-lines inbox (violates the human-readable-markdown premise, which is the product).

**A15. Transactional mutations from skills go through a bundled helper script, never raw
model edits.** `hooks/inbox-tx.mjs` wraps criterion-4 primitives; integrate/remember
invoke it via Bash. It lives beside the hook bundles deliberately — `hooks.json` is the
hook registry, the directory is not — but it is not a hook: it reports failures via
stderr + non-zero exit like the CLI it prefigures, and is exempt from the U2 no-stderr
rule (architecture-review fix). *Rejected:* model Edit for snapshot-clear (cannot hold
the concurrent-append invariant; Edit on a changed file fails or clobbers — spec MAJOR);
deferring the helper to run 3's CLI (leaves run 2's integrate skill unable to honor the
spec's own "inbox is never lost" contract); a separate `bin/` dir (a second bundled
output location for one file; run 3's CLI reuses the criterion-4 primitives, not this
wrapper, so nothing is prefigured wrongly).

**A16. Hook work is two-lane: the response lane is budgeted, the maintenance lane is
best-effort and yields.** Injection/pointers/capture must complete; decay, queue claims,
and sweeps run only when uncontended (first-attempt lock, ≤1 job) and skip silently
otherwise — the next session retries. *Rejected:* maintenance on the response path (the
spec's own bounds compose to a 5 s lock wait inside a <1 s budget — spec MAJOR); a
background daemon (nothing in v1 owns a resident process; the spec's durable queue exists
precisely so short-lived processes can hand work forward).

WORLD_MODEL check: A12 upholds A1/A3/A9/A11/U2; A13 amends the run-1 cursor contract
(named amendment, gate-visible); A14 extends A4; A15 upholds A2/A6; A16 upholds A2 and
**adds a bound to A8's protocol family** — the hook-maintenance lock mode (1 attempt,
skip and defer to next session) is a new named bound, not an uphold, and is recorded in
A8's bound list when C writes the WORLD_MODEL entries (architecture-review fix) — and
amends the spec's hook-latency table (named amendment). No entry of A1–A11 is
contradicted. A12–A16 are ADR candidates recorded in WORLD_MODEL at landing.

## UX

Intended users: a Claude Code power user mid-session, and the model itself reading
injected context. Both see hook output; neither reads the implementation.

**U4. Injected context is one framed block with a hard ceiling.** Wiki injection ≤800
tokens (run-1 allocation) plus ≤~50 tokens of maintenance lines (nudge / warning / compact
notice / init notice), total documented as ≤850 — the spec's "~800 total" claim is amended
rather than silently exceeded (adversary MINOR). Maintenance lines are plain
imperative one-liners ("mehmory: inbox has 14 entries — run /mehmory:integrate").
*Rejected:* counting maintenance inside the 800 (silently shrinks the wiki injection the
user tuned); unbounded appends (re-opens the exact arithmetic bug run 1's blocker fixed).

**U5. `remember:` acknowledges without hijacking.** The prompt passes through unchanged;
the ack is one `additionalContext` line ("mehmory: captured to inbox") so the model can
acknowledge without re-saving and the user gets confirmation. *Rejected:* blocking the
prompt (the user's turn dies for a side effect); silent capture (user cannot tell whether
it worked — the distrust the product exists to fix).

**U6. Stop's block reason is a bounded instruction, not an essay.** Fixed template naming
what to append (durable decisions, corrections, gotchas since last capture), where
(inbox via the entry format), and that normal stopping resumes after one pass. Fires once
per threshold crossing. *Rejected:* re-block until inbox changes (a model that has nothing
to save is trapped); free-form reason per invocation (unbounded tokens at the highest-
frequency hook).

**U7. Pausing is layered and visible.** `/mehmory:pause` sets the session flag;
`hooks.<name>.enabled` config keys disable per-hook per-project/global; precedence
session > project > global. Paused sessions emit nothing (not even pointers) so "paused"
is verifiable by absence; `resume` restores. *Rejected:* env-var switch (invisible,
undiscoverable, survives nothing); uninstall-to-pause (destroys the trust loop for a
temporary need).

**U8. Failure stays silent in-session, surfaces at SessionStart.** Hooks never print
errors mid-session (fail-open, U2); repeated failures reach the user as the single
pending-warning line at next SessionStart with the run-1 error template. First run
auto-inits with a one-line notice instead of hinting at a CLI that ships in run 3
(adversary MAJOR). One caveat recorded, not hidden: model-driven writes to `~/.mehmory`
(skills, Stop compliance) are subject to Claude Code permission prompts; when denied,
layer (b) capture degrades to deterministic layer (a) — documented in each skill's
description and the spec amendment; `allowed-tools` frontmatter narrows what skills
request. *Rejected:* stderr warnings (swallowed on exit 0 — run-1 U2 finding); prompting
the user to grant permissions from inside a hook (hooks must never block the harness).

## Subtasks

Serial: D unlocks A (D rewrites eslint config + pre-commit that A's new code must pass);
A unlocks B and C (they consume A's library surface); B ∥ C touch disjoint files.

- **D — debt + gates.** Correct the `strictTypeChecked` spread and fix all ~161 existing
  violations across `src/` and `test/`; add `pnpm typecheck` to `.husky/pre-commit`
  (retro P5); rewrite `test/lock.test.ts` bound assertion (no real 5 s sleep);
  remove/replace the tautological truncation assertion; AGENTS.md P6 pointer + run-2
  structure section (written from this plan; verified against reality at verify stage);
  add `hooks/` (built output) to `.gitignore` **and** to the eslint flat-config ignore
  list — the current ignores end at `**/*.js`, which does not match `.mjs`, so the built
  bundles would fail criterion 1's gate the moment B builds (contract-review fix). Owns
  `eslint.config.js`, `.husky/`, `.gitignore`, `AGENTS.md`. → criteria 1, 2, 20.
- **A — library extensions.** Inbox entry format + `appendInboxEntries`/
  `snapshotClearInbox` (format.ts + new `src/core/inbox.ts`); session-state module
  (`src/core/session.ts`: cursor scoping, counter, topic cache w/ Jaccard, project-key
  cache, pause flag, sweep; removes global-cursor API); record-embedded-sessionId distill
  IDs; decay file ops (`src/core/decay.ts`); stats writer (`src/core/stats.ts`); grep
  matcher (`src/core/match.ts`); config keys (`inbox.nudge_*`, `session_state.
  max_age_days`, `match.jaccard`, `match.cache_ttl_ms`, `queue.claims_per_start`,
  `hooks.<name>.enabled`). Owns `package.json`/`tsup.config.ts`: the hook/helper bundle
  entry is a **glob** (`src/hooks/*.ts` → self-contained `hooks/*.mjs`), bundling
  whatever exists — no stubs, no explicit paths to files B and C haven't written yet
  (run 1's stub defects, and explicit entries would break each parallel tail's build);
  the library entry **excludes `src/hooks/**`** so hook internals never become library
  exports. Also owns the shared test infrastructure both tails consume:
  `vitest.config.ts` and the `test/setup.ts` hermetic guard extended to subprocess env
  (criterion 21) — B and C never touch these. → criteria 4, 5, 6, 19 (library half), 21.
- **B — hooks.** `src/hooks/{session-start,user-prompt-submit,stop,pre-compact,
  session-end}.ts`, `hooks/hooks.json`, fixture test suites spawning built `.mjs`
  (`test/hooks-*.test.ts`), plus `test/plugin-hooks-layout.test.ts` (hooks half of
  criterion 3 — its own file, no shared test file with C). → criteria 3 (hooks half),
  7–16, 19 (wiring).
- **C — skills + packaging + amendments.** Six SKILL.md files, `.claude-plugin/
  plugin.json`, `src/hooks/inbox-tx.ts` → bundled helper + its direct tests
  (`test/inbox-tx.test.ts`, `test/plugin-skills-layout.test.ts` — no shared test file
  with B), SCHEMA.md additions (ephemeral refresh-or-delete guidance, entry-format
  note), spec `## Run-2 amendments` section, WORLD_MODEL A12–A16 + amendment entries
  (incl. the A8 addition — maintenance-lane lock mode). → criteria 3 (skills half), 17,
  18.

Unlock conditions: D merged to run branch → A; A merged → B, C in parallel.

## Dispatch shape

`swarm` — four units with two genuinely parallel tails (B, C touch disjoint files);
solo would serialize ~two days of independent work behind one context. Worker isolation
per retro: every worker in a worktree, never the main checkout, even when running alone.

## Spec gaps and inferences

All spec-stage adversary findings triaged. Each entry below is a decision the spec did not
make (or made wrongly); all land as the spec's `## Run-2 amendments` section via subtask C.
Items 1–3 resolve the blockers; every MAJOR/MINOR is resolved or explicitly deferred.

1. **PreCompact cannot block (BLOCKER).** The real PreCompact hook has no decision control
   and no additionalContext. Amend: PreCompact = deterministic distill only; the
   model-facing "compaction happened, state captured" notice moves to SessionStart's
   `compact` matcher, which does support injection.
2. **Session-scoped capture state (BLOCKER).** Run 1's global `cursor.json` contradicts
   spec line 78 (per-session offsets). Amend: cursor lives in `.state/<session-id>.json`;
   global-cursor API removed (nothing shipped consumes it). This changes a run-1 library
   contract and is raised explicitly at the gate — approving this plan approves that break.
3. **Normative inbox entry serialization (BLOCKER).** One line per entry with
   machine-readable id/src/ts trailer, owned by `format.ts` per A4. Threshold "~10
   entries" becomes countable.
4. **`remember:` is pass-through + ack (MAJOR).** Hook cannot rewrite prompts; blocking
   kills the turn. Ack via additionalContext.
5. **SessionEnd has no background (MAJOR).** "Background final distill … returns
   instantly" amended to: enqueue durable `distill-final` job; claimed by the next hook
   invocation (run 2) or CLI (run 3); SessionStart claims ≤1 job per invocation on the
   maintenance lane.
6. **`onboard-session` defined (MAJOR):** in-session onboarding — survey the project,
   seed project.md/pages/index per SCHEMA.md, commit. Distinct from run-3 CLI
   transcript-mining onboard.
7. **Stable IDs key on record-embedded sessionId (MAJOR)** — resume mints no duplicates.
8. **Stop counter semantics (MAJOR):** counter = Stop invocations since last capture;
   reset on every capture; block once per threshold crossing; `stop_hook_active` exits
   without increment.
9. **SessionStart budget split (MAJOR):** <1 s applies to the injection path; maintenance
   (decay, sweep, ≤1 queue claim) is best-effort, skipped when the project lock is not
   free on first attempt. A16.
10. **UserPromptSubmit budget restated (MAJOR):** <100 ms in-hook work, <300 ms
    end-to-end target incl. node startup; project key cached in session state; both
    measured via stats.jsonl. The original figure is physically unmeetable per process
    spawn overhead. **This changes a fixed, user-approved KPI-table number (spec line
    156) — raised explicitly at the gate: approving this plan approves this change.**
11. **Integrate's transactional surface (MAJOR):** bundled `inbox-tx.mjs` helper; skills
    never raw-Edit the clear step. Run 3's CLI reuses it.
12. **Permission-prompt reality (MAJOR):** model writes to `~/.mehmory` may prompt; denied
    → layer (b) degrades to layer (a); skills declare `allowed-tools`; documented, not
    hidden.
13. **First-run auto-init (MAJOR):** SessionStart calls idempotent `initStore()` when the
    store is missing; no dead `mehmory init` hint before run 3.
14. **Maintenance token allowance (MINOR + UX MAJOR):** at most 2 maintenance lines per
    SessionStart, priority warning > compact notice > nudge > init notice; allowance 150
    tokens (one run-1 U1 warning line alone is ~57 tokens, so "~50" was arithmetically
    broken when lines stack); combined injection **asserted** ≤ 950 estimated tokens in
    the worst-case fixture, not documented-only. **This changes the fixed KPI-table
    "Injection budget ≤800 (code-enforced cap)" (spec line 155) — raised explicitly at
    the gate: approving this plan approves this change.**
15. **stats `project` field is the project key slug (MINOR)**, not the pre-UC3 path-hash.
16. **Session-state sweep (MINOR):** SessionEnd deletes own file; SessionStart maintenance
    sweeps files older than `session_state.max_age_days` (default 14).
17. **Pause flag storage (MINOR):** session flag in session state + `hooks.<name>.enabled`
    config; `pause`/`resume` shipped as skills this run (two tiny SKILL.md files against
    machinery the hooks need anyway). Precedence made subtractive-only (contract + UX
    fix): the session flag **only ever disables** — `resume` clears the session flag and
    never re-enables a hook config-disabled at project/global level. Known run-2 gap,
    recorded: a persistent `hooks.<name>.enabled=false` is silent until run-3 `doctor` —
    there is no resurfacing surface this run; deferral named, not hidden.
18. **Jaccard threshold named (MINOR):** ≥ 0.7 skips lookup, config key `match.jaccard`.
19. **`ephemeral` staleness (resolves run-1 amendment 10):** no age threshold and no
    config key — every integrate pass refreshes-or-deletes ephemeral-marked content, per
    the spec's own line 98. Decision recorded; the deferred question is closed, not
    re-deferred.
20. **Positive-path fixtures mandatory (MINOR):** every hook has at least one positive
    fixture in its done-when criterion — an all-no-op hook set cannot pass.
21. **Dedup window weakening (contract-review):** inbox dedup is id-in-file, so after an
    integrate clears the inbox, a cursor reset can re-introduce already-integrated
    entries; "replay is a no-op" holds until the next integrate, whose editorial merge
    absorbs duplicates. Recorded as an amendment, not left as a silent inference.
22. **Warning-drain fallback (UX FAIL):** the pending-warning channel's only outlet was
    SessionStart — the most complex hook, i.e. the failure and its reporting channel were
    the same process. UserPromptSubmit drains one pending warning when SessionStart's
    last stats entry for the project is stale or absent.
23. **Maintenance lock mode added to A8 (architecture-review):** hook-maintenance lane
    lock = 1 attempt, skip and defer to next session — a new named bound in A8's
    protocol family, recorded there; not an uphold of the existing 50 × 100 ms bound.
24. **Stop block reason embeds an executable action (UX FAIL):** the helper invocation or
    `/mehmory:remember` — never the raw entry serialization, which a model cannot produce
    (sha256 ids) and A15 forbids it hand-writing.

## Envelope

- `dispatch_budget`: **11** — 4 execution workers (D, A, B, C), 1 verifier, up to 2 fix
  attempts, 2 reserved for landing-stage review findings + re-verify, 1 spare.
- `usage_budget_hours`: **3**.
- Intake-charged (not counted above): 4 review dispatches — spec adversary (spent),
  contract, architecture, UX.
- Experiments: 0 used, 2 available.

## Stages

- **Intake depth:** ambient (crisp — approved spec, slicing fixed at run 1). Two
  confirming questions asked: FTS boundary (grep-only run 2), run-1 debt inclusion (all).
- **Architecture design:** `fired` — clauses 1 (new module boundaries: src/hooks, plugin
  package), 2 (new composition edges: hooks→core, skills→helper→core), 3 (shared
  session-state abstraction), 4 (contradicts run-1 cursor contract → named amendment;
  establishes A12–A16).
- **UX design:** `fired` — clauses 1 (injected text, ack lines, block reason — text humans
  and the model read), 2 (six skill trigger phrases/descriptions), 3 (pause/resume and
  integrate-on-nudge are steps a human walks through).
- **Design review:** spec stage `fired` (spec touches hook contracts) — complete: 3
  BLOCKER / 10 MAJOR / 7 MINOR / 3 PASS, all triaged into Spec gaps above. Plan stage
  `fired` — three fresh dispatches complete: contract 0 BLOCKER / 6 MAJOR / 5 MINOR /
  3 PASS; architecture 4 PASS / 3 MINOR; UX 1 PASS / 2 FAIL / 1 MAJOR / 3 MINOR. One
  amendment round applied, exactly the reviewers' proposed fixes → verdicts carry
  forward bound to plan+amendments, no re-review (1 of 2 amendment rounds used).
  Evidence in `## Design review` below.
- **Experiment stage:** not fired — no contested finding yet, no hold-my-beer, no user
  ask.
- **Dispatch shape:** swarm, 4 units, serial D→A then B ∥ C.
- **Verification:** fresh verifier on the blessed swarm branch, briefed with the 21
  criteria; swarm unit verdicts are inputs, never substitutes.
- **Landing:** `auto-land`.

### Author-time checklist

1. *Cross-artifact consistency:* the script-prose pairs are the 5 hooks (hooks.json +
   spec table + criteria 7–16) and the inbox-tx helper (criterion 17 + skill prose).
   Externally observable behaviors per hook — SessionStart: additionalContext, auto-init,
   nudge, warning, compact notice, maintenance skip (criteria 7–9); UserPromptSubmit:
   pointers, silence, cache skip, remember ack (10); Stop: increment, block-once,
   stop_hook_active no-op (11); PreCompact: distill only, no decision (12); SessionEnd:
   enqueue, log, commit, state delete (13); all: exit 0 fail-open, stats line, redaction
   (14–16). Skill-observable behaviors: integrate/lint stats lines are in criterion 17
   (contract-review orphan, closed). Every behavior maps to a criterion; every criterion
   3–21 maps to a subtask (D→1,2,20; A→4,5,6,19,21; B→3,7–16,19; C→3,17,18). No orphans
   either direction.
2. *State-machine completeness:* **Session state:** absent →(any hook creates) active
   →(SessionEnd deletes | sweep deletes >14d) gone [terminal]; corrupt →(reset+log)
   active. **Stop counter:** any value →(Stop invocation, not stop_hook_active) +1;
   any value →(capture: Stop-threshold **or PreCompact**) 0; stop_hook_active → no
   transition; the SessionEnd job resets nothing (its session state is already deleted).
   **Inbox entry:** to-append →(id already in file) skipped [terminal] | →(append)
   appended →(integrate snapshot) snapshotted →(clear under lock) integrated [terminal];
   appended-during-snapshot → survives as appended. **Queue job** (run-1 machine, new
   consumer): queued →(SessionStart claim) claimed →(applied) [terminal] | (3 fails)
   failed [terminal]. **Pause:** unset →(pause) paused →(resume) unset; subtractive-only
   against config. All non-terminal states have entry + exit (contract-review fixes
   applied).
3. *Loop-bound rule:* Stop block once per threshold crossing (guarded by counter reset +
   stop_hook_active); SessionStart claims ≤ `queue.claims_per_start` (default 1); decay
   skipped unless first-attempt lock (no retry loop on injection path);
   `snapshotClearInbox` under `withProjectLock` 50×100 ms bound (skill path — the
   concurrent-mutation path contract review flagged); topic cache TTL 5 min; sweep bound
   by max_age_days; queue claim 3 attempts (run 1); verify fix loop ≤2 (skill);
   amendment rounds ≤2 (skill). No unbounded loop.
4. *Why shouldn't we do this?* Run 2 wires live hooks into real sessions — the first run
   with user blast radius; a defect here breaks sessions, not tests. Mitigations: fail-open
   is lint-enforced (A11/U2), every hook fixture-tested as a subprocess, landing does not
   install the plugin (user opts in). Second: A13 breaks a run-1 library contract; safe
   only because nothing shipped consumes the cursor yet — raised at the gate, and run 3
   inherits the new contract.
5. *What goes wrong when we do this?* (a) Latency budgets miss in the field — mitigated by
   two-lane split + stats measurement; budgets are measured claims, not CI assertions.
   (b) Permission prompts gut layer-(b) capture — documented degradation, deterministic
   layer (a) unaffected. (c) Skill prose is unenforceable — the transactional step goes
   through a tested helper; prose carries only judgment work. (d) Grep matching is noisy
   vs FTS — pointers capped at 3, cache suppresses repeats, run 3 upgrades. (e) The
   6-skill set exceeds the spec's 4 — pause/resume are gate-item-30 machinery; named in
   scope, raised at gate.
6. *Artifact enumeration:* greps run at intake — `git ls-files | grep -vE
   '^(docs|src|test|assets)/'` → config/tooling files only, each now explicitly owned
   (D: `eslint.config.js`, `.husky/`, `.gitignore`, `AGENTS.md`, `eslint-rules/` rule
   scoping; A: `package.json`, `tsup.config.ts`, `vitest.config.ts`, `test/setup.ts` —
   contract-review fix closed the unowned `vitest.config.ts`/`.gitignore` hits);
   `grep -rln 'hooks/|skills/|claude-plugin|hooks\.json|stats\.jsonl'` over src/test/
   configs → no hits (nothing collides with the new dirs); `grep -n 'cursor.json'
   src/core/cursor.ts` → the global path A13 removes; `tsup.config.ts` entry glob already
   covers `src/**/*.ts` (hook entries need explicit bundle config — A owns);
   `ls ~/.mehmory` → absent (no live store to migrate); `.husky/pre-commit` → `pnpm lint
   && pnpm test` (P5 adds typecheck). Every hit covered by the subtask file-ownership
   lists. No unaccounted hits.

## Open decisions

None.

---

## Design review

Four dispatches, all pre-gate, all intake-charged. One amendment round, applied as
exactly the reviewers' proposed fixes (round 1 of 2); verdicts carry forward bound to
plan+amendments.

**Spec stage — chaos-engineer adversary vs. the spec's run-2 surface.** FAIL: 3 BLOCKER /
10 MAJOR / 7 MINOR / 3 PASS. Blockers: PreCompact block impossible under the real hook
contract (no decision control, no additionalContext — capture leg moved to
SessionStart(compact)); capture cursor is a global singleton where spec line 78 requires
per-session offsets (interleaved sessions alternate file_id → perpetual rotation-reset →
full re-distill); inbox.md serialization never fixed while four specced behaviors parse
it. Majors: remember:-prefix observable behavior undefined; SessionEnd "background"
contradicts A9 with no run-2 claimant; onboard-session named 3× defined 0×; stable IDs
break on resume (hook session_id vs record-embedded sessionId); Stop counter re-fires
with period 2; SessionStart <1s breached by its own composed bounds (5s lock wait);
UserPromptSubmit <100ms unmeetable (node spawn alone); integrate transactionality has no
executable surface; model writes to ~/.mehmory hit permission prompts; first-run rescue
points at run-3 CLI. All triaged into Spec gaps 1–20. Three PASSes with evidence
(remaining loop bounds; SessionStart/Stop map to real hook mechanisms; run-1 library
surface matches claimed contracts, spot-checked at file:line).

**Plan stage — contract reviewer.** 0 BLOCKER / 6 MAJOR / 5 MINOR / 3 PASS. Majors:
integrate/lint stats line orphaned from criteria (→ criterion 17); Stop-counter and
inbox-entry state machines incomplete (PreCompact reset missing, SessionEnd-job reset
incoherent, dedup-skip transition absent → both redrawn); snapshotClearInbox
concurrent-mutation path unguarded (→ withProjectLock); gaps 10/14 change fixed KPI
numbers without gate-raise markers (→ marked); eslint ignore list misses hooks/*.mjs and
vitest.config.ts/.gitignore unowned (→ D/A ownership); A pre-declaring bundle entries for
unwritten files breaks parallel builds (→ glob entry, no stubs). Minors: B/C shared test
surfaces (→ split files, guard to A); probe-commit gameable (→ verifier reproduces);
≤850 unenforced (→ asserted ≤950 worst-case); pause precedence underdefined (→
subtractive-only); dedup window closes at integrate (→ recorded as gap 21).

**Plan stage — architecture reviewer.** 4 PASS / 0 FAIL / 3 MINOR. PASSes with evidence:
no unacknowledged WORLD_MODEL contradiction (A13's cursor-API removal verified sound —
grep shows no src/ consumer); no silent architectural establishment; alternatives real
(thinnest: A12's mega-hook rejection, half-circular but carried by testability); deletion
survival holds incl. run-3 FTS swap-in and CLI reuse of criterion-4 primitives. Minors:
A16 is an A8 addition, not an uphold (→ recorded in A8's bound list); inbox-tx placement
and error channel named (→ A15 text, U2 exemption); queue drain rate hardcoded (→
queue.claims_per_start named bound).

**Plan stage — UX reviewer.** 1 PASS / 2 FAIL / 1 MAJOR / 3 MINOR. FAILs: Stop block
reason not executable as written (model cannot compute sha256 ids; raw appends violate
A15 → reason embeds helper invocation); warning channel's single outlet was SessionStart
itself — the failure and its reporting channel were the same process (→ UserPromptSubmit
warning-drain fallback, gap 22); persistent config-disable silent until run-3 doctor (→
deferral named in gap 17); corrupt-store-git fixture missing (→ criterion 15d). MAJOR:
maintenance token allowance arithmetically broken when lines stack — one U1 warning line
≈ 57 tokens vs a ~50 allowance (→ 2-line priority scheme, 150-token allowance, asserted
≤950). Minors: init/compact notices carry no next action (→ onboarding pointer,
integrate invocation); pause cross-axis semantics (→ subtractive-only); empty-store
output unspecified (→ identity frame + onboarding pointer; silence reserved for
paused/failed). PASS: no unjustified second surface (remember: prefix vs skill is
gate-chosen T2; nudge phrasing matches real plugin invocation form).

---

## Execution ledger

landed: 2026-07-30T12:03:42Z (PR #2 squash-merged as 63b3f17; measurement window approved 2026-07-29 → landed 2026-07-30)

**Dispatches: 9 of 11** (intake-charged separately: 4 of 4 — spec adversary, contract,
architecture, UX reviewers). Execution: D (sonnet), A, B, C (opus) workers; V1 batch
verifier (D+A, opus, spare slot); I integration worker (opus); V2 final verifier (opus);
F docs touch-up (sonnet); R review-fix worker (opus, landing reserve). 0 retries, 0 fix
attempts against failed verdicts (none failed), 2 of 2 verifications, 1 of 2 landing
reserve spent. 0 experiments. Branch feat/runtime, 33 commits + squash.

### Defect-catch tally (born-at → caught-at)

| Stage caught | Count | Notes |
|---|---|---|
| Spec stage (adversary) | 20 | 3 BLOCKER / 10 MAJOR / 7 MINOR — all born in the spec, resolved as amendments before planning |
| Plan stage (3 reviewers) | 20 | contract 6M/5m, architecture 3m, UX 2F/1M/3m — all applied as amendment round 1 |
| Impl (worker-noticed, `Plan defects noticed:`) | 15 | D:1 (stale debt inventory), A:5 (config shape break, index-line format, archive index lines, inbox-tx snapshot persistence, concurrency-test scope), B:6 (git stderr leak — fixed in-branch, missing tryProjectLock — added, missing completeJob — added, stop threshold key, hook scope unspecified, tsup chunks), C:2 (store.ts ownership gap, clear-arg channel), R:1 (errors.ts rotation had the same bug Copilot found in stats.ts) |
| Lead triage (pre-verify) | 1 | Stop-reason ↔ inbox-tx contract mismatch, visible only across B's and C's reports — fixed by integration unit before any verification ran |
| Verify (V1, mid-run) | 4 | 2 BLOCKER born in D (.gitignore `hooks/` swallowed `src/hooks/`; committed hooks.json impossible) caught after D+A reported green; 2 minor |
| Verify (V2, final) | 0 FAIL | 4 minor observations (AGENTS.md staleness → fixed by F; 950 headroom; redundant redact layer; skill fallback path) |
| Landing (Copilot) | 4 | empty session_id state pollution, hot-path config re-read, Windows rotation break, quote-brittle embedded command — all fixed pre-merge |
| Post-ship | 0 | as of landing |

Worker report fields: all 8 workers returned `Plan defects noticed:` and `Own mistakes
made:` with explicit `none` where applicable. Own-mistake themes: assuming plan/spec
descriptions over reading code first (D), reusing primitives without checking return
types (A), one tautological assertion caught pre-commit (B), one pre-commit hook bypass
after manual partial checks (C — full suite was green on final tree; recorded).

### Recommendations (Q / Rec / Chosen)

1. FTS boundary for run-2 UserPromptSubmit / grep-only, FTS in run 3 / same — aligned.
2. Run-1 debt inclusion / include all / same — aligned.
3. Plan approval incl. 3 gate-raised contract changes / approve / approved — aligned.
4. Security path-trigger classification / proceed as lexical false positives (with clean
   security review) / same — aligned. 4/4 this run.

### Judgments ledger

- Security classification wave-through (user decision, recorded in auto-land ledger):
  path triggers were lexical false positives; expected outcome — no post-ship security
  finding on the flagged surfaces (pivot signal: any such finding ⇒ tighten the
  carve-out reading, stop treating category misfires as waivable).
- No named bets: no contested finding survived a debate round, no caps were hit.

### Escalations

1. Security-sensitive classification (auto-land step 2, mandatory) — resolved: proceed.
No other stop conditions fired. Envelope never breached; every dispatch counted before spend.

### Delivered-vs-approved diff

Done-when evidence: V2 verifier PASS on all 21 criteria at d9d2fab (break/restore probes,
cited per criterion), carried forward through the criteria-preserving landing-stage fixes
(R's Stop-reason change strengthened criterion 11's executable-command property; its test
executes the extracted command with an apostrophe-bearing learning).

Beyond the subtask file lists, all traceable:
- `src/core/hook.ts`, `src/core/capture.ts`, `fs.readStdin`, `lock.tryProjectLock`,
  `queue.completeJob` — library placements forced by A12 (hooks stay thin adapters);
  trace to criteria 7–16.
- Integration unit's merge + Stop↔inbox-tx contract fix — trace to criteria 11/17.
- `.gitignore` `/hooks/*.mjs` correction — enabler for criterion 3 (V1 blocker).
- `src/core/git.ts` stderr piping — criterion 15d/U2.
- `src/core/errors.ts` rotation fix — same-bug companion to Copilot finding 3.
- F's AGENTS.md accuracy pass — standing convention (global CLAUDE.md: docs updated with
  structure changes), citable.
- Mandated state: this run file, `.elderfo/` gitignore entry (auto-land ledger home),
  `.swarm/` archives (gitignored). No untraceable change.

### Pointers

- Swarm archive: `.swarm/archive/SWARM_STATE-2026-07-30-runtime.md`; unit reports under
  `.swarm/reports/`.
- PR: https://github.com/elderfo/mehmory/pull/2 (squash 63b3f17). Run-1 stale swarm state
  (8 worktrees, 9 branches) cleaned and archived at run start.
- For run 3: `stop.capture_threshold` config key (B), tsup `splitting: false` for
  literal self-containment (B), index-line format as format.ts constant (A/C), V2's
  minor observations in `.swarm/reports/v2-final/verdict.md`.
