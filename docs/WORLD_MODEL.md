# Mehmory World Model

## Architectural Decisions

This document records the architectural decisions (ADRs) established in run 1. These are binding on runs 2 and 3.

### A1. Plugin seam at the top level

Memory is a library, not a framework. The CLI, hooks, and skills are all replaceable consumers of the library; the library does not import them. Plugins provide hooks as `.mjs` files; the host orchestrates them.

**Rejected:** A monolithic CLI that owns hooks and skills (blocks parallel subtasks, makes the library a hidden framework rather than a visible platform).

### A2. Fail-open guarantee

Any error in memory operations returns a fallback (defaults for config, empty for captures, proceed-without for locks). Memory never breaks the harness. Error is logged; continued operation is mandatory.

**Rejected:** Hard failure on unrecoverable error (breaks user sessions over a disk I/O hiccup or a clock skew).

### A3. `node:fs` imports only in `src/core/fs.ts` and `src/core/errors.ts`

All file I/O is mediated through `src/core/fs.ts` so the module dependency graph is controllable and testable. Errors are an exception: errors.ts must be able to log to disk before fs.ts exists, so it has its own bounded append.

**Rejected:** Scattered fs calls (defeats the purpose of a fs layer).

### A4. Format constants are code, not data

`src/schema/format.ts` exports machine-parsed constants (FORMAT_VERSION, page types, decay classes, frontmatter keys). `assets/SCHEMA.md` is editorial—read by humans only, never parsed. This allows runs 2–3 to change the template deliberately without drifting.

**Rejected:** Constants in SCHEMA.md (makes the file a data input and a natural place for shadow defaults to accumulate).

### A5. Normalized git-remote slug as project identity

A project's memory is keyed by its normalized remote URL (`github.com/owner/repo`), falling back to a hash of the repo root path (local repos), falling back to CWD. Two worktrees of one remote share one memory by design. `config.json` alias entries override the key for splits and merges.

**Rejected:** Worktree-local memory (fragments memory across logical siblings; forces the user to maintain two copies of the same decision).

**Irreversibility note:** A5 is permanent once user directories exist under `~/.mehmory/projects/<slug>/`. The alias map is the escape hatch for merges and splits; there is no cheap reversal of the scheme itself. Accepted deliberately: the spec's UC3 gate already chose it, and the evidence (worktree fragmentation) is concrete.

### A6. `initStore()` owns git init

The store layout and git init are coupled: a memory without a git repo is not durable. `initStore()` is idempotent—running it twice is a no-op. `src/core/store.ts` (subtask F) owns this; no other module calls `git init`.

**Rejected:** Lazy git init (delays idempotency testing, couples init to the first append operation, hides failures).

### A7. Fixtures are normative

Distill patterns and the error registry are established at run 1 and are a contract for runs 2–3. A bad fixture is a permanent bad contract. Fixtures derive from real transcripts, redacted, not invented.

**Rejected:** Extensible patterns (makes the contract fuzzy; a later run wonders if it owns the power to change them).

### A8. All fail-open bounds are one protocol

A8 defines bounds for fail-open operations in one module so later runs can override them together:
- Log rotation: 5 MB, keeping 1 prior generation
- Warning rate limit: 1 per hour per error code
- Lock retry: 50 × 100 ms then proceed lock-free
- `index.lock` defer: retry 1 × then defer with no queue

**Rejected:** Hardcoded bounds (scattered magic numbers make overrides fragile).

### A9. Core is synchronous

Exported functions from `src/core/` are synchronous. No Promises, no async/await. Concurrency is a property of the harness and the hook scheduler, not of the library. Enforced by an ESLint rule (`no-exported-promise`) that flags `async`, `Promise<>` return types, and `await`.

**Rejected:** Async boundary (adds complexity to every consumer; the harness is the right place for async).

### A10. ESM only

`tsup` emits ESM; hooks are bundled `.mjs`; the CLI is a bundled ESM binary. No CJS output. This is simpler (no dual-build, no .d.cts files) and matches Node 22's mainstream path.

**Rejected:** Dual CJS/ESM output (two artifacts to test for one consumer set we fully control); CJS (hooks are `.mjs` per the spec).

### A11. Core never exits the process and never throws across its boundary

Exported functions return values or typed errors via `MehmoryError`. `process.exit()` and `process.abort()` are banned in `src/core/` by ESLint rule. This makes A2's fail-open promise enforceable rather than aspirational—a library that can exit can kill the user's session.

**Rejected:** Exit on unrecoverable (there is no error worth killing a user's session over).

---

## Run-1 Amendments

These items resolve findings from the spec-stage and plan-stage design reviews:

1. **Injection allocation (resolves BLOCKER: 200+200+500=900 > 800).** Identity 200 / project 200 / index 400 = 800, truncating in the spec's priority order. Identity is never dropped entirely.

2. **Record atomicity.** Every inbox/log/stats record is exactly one `\n`-terminated line written in one `write()`; embedded newlines are JSON-escaped. Ceiling: 4 KiB, above which `index.lock` path is used.

3. **`index.lock` defer bound.** Retry once after 100 ms; then leave staged and return `deferred: true`. The next `commitPaths` commits accumulated paths—bounded because deferral accumulates no queue.

4. **Queue claim protocol.** Claim by atomic `rename()` into `queue/claimed/`; stale claims reclaimable by mtime; 3 failed claims → `queue/failed/`.

5. **Concurrent-session decay race.** Index rewrites and decay run under `withProjectLock`; lock acquisition is itself fail-open after bounded wait.

6. **Cursor rotation/truncation.** Cursor carries `dev:ino` and `size`; rotation or truncation resets the offset. Stable entry IDs make replay a no-op.

7. **Worktree/clone identity fork.** Clones and worktrees of one remote share one memory, deliberately. Alias map overrides.

8. **`pointers-followed` KPI.** Removed from v1; `pointers_offered` remains as the measurable proxy.

9. **Toolchain:** pnpm, vitest, tsup, eslint + prettier, husky — chosen per host conventions.

10. **`ephemeral` staleness threshold** deferred to run 2 with the integrate skill; run 1 only defines decay class constants.

11. **FTS5 availability** was measured at intake: Node 22.22.3 / SQLite 3.51.3 builds `fts5` with both `porter unicode61` and `trigram` tokenizers. No spec change; recorded as evidence for run 3.

12. **Queue job-type contract.** `enqueueJob(jobData, jobType?)` stores the type as a reserved `_jobType` key merged into the job payload. `claimJob(jobType?)` claims only jobs whose `_jobType` matches; omitting the argument claims any job, preserving original behavior. Producers must treat `_jobType` as reserved and not use that key for their own data. Alternative (`{ type, data }` envelope) was rejected in favor of the flat key.

### Amendment: Spec gaps 15 and 16

Two amendments change contracts the spec fixed:

**15. Warning channel (addendum item 23).** The spec's addendum says "rate-limited one-line stderr warning". Amending: stderr is swallowed for a hook exiting 0, so the warning travels `errors.log` + `pendingWarnings()` + SessionStart injection instead.

**16. Conditional `Fix:` clause (addendum item 27).** The spec's addendum mandates a `Fix:` clause on every error. Amending: errors with no correct user action omit it rather than inventing advice.

These amendments are accepted as part of run 1's design review and are recorded here as binding on runs 2–3.

---

## Architectural Decisions — Run 2

Established in run 2 (hooks, skills, plugin packaging). Binding on run 3.

### A12. Hooks are thin adapters; every behavior lives in `src/core|schema|distill`

Each `src/hooks/<name>.ts` parses stdin JSON, calls library functions, and serializes
stdout JSON — no business logic — upholding A1 (library, not framework). The eslint
boundary rules (A3 fs-ban, A9 sync, A11 no-exit, U2 no-stderr) extend to `src/hooks/`.

**Rejected:** Logic in hook files (untestable except through a subprocess, and run 3's
CLI would have to duplicate it); one mega-hook script with a mode switch (five
registrations exist in `hooks.json` regardless, and a shared-core/five-entrypoints bundle
gets the same deduplication without a dispatch layer).

### A13. Capture state is session-scoped

One `.state/<session-id>.json` per session holds the transcript cursor, the Stop counter,
the topic cache, the cached project key, and the pause flag. This **amends run 1's global
`cursor.json` contract** (run-2 amendment 2); the global-cursor API is removed rather
than kept alongside — one way to do it, and nothing shipped consumes it yet, so the break
is free now and expensive after run 3.

**Rejected:** Global cursor (spec blocker: interleaved sessions reset each other into a
full re-distill); separate files per concern (`cursor.<id>`, `topics.<id>`, … — N files
to sweep and corrupt independently); keying by transcript path (resume copies
transcripts; the session id is the stable handle the hook actually receives).

### A14. Inbox entries are a code-owned single-line format (extends A4)

Serialization lives in `format.ts` with a round-tripped parse/serialize pair. The text is
human-readable markdown; a trailing HTML comment carries machine identity.

**Rejected:** Freeform markdown bullets (snapshot-clear and dedup become heuristics — the
spec blocker); a sidecar index file (two artifacts that drift, while the inbox is meant
to be self-contained and human-editable); a JSON-lines inbox (violates the
human-readable-markdown premise, which is the product).

### A15. Transactional mutations from skills go through a bundled helper, never raw model edits

`hooks/inbox-tx.mjs` wraps the inbox primitives; `integrate` and `remember` invoke it via
Bash. It lives beside the hook bundles deliberately — `hooks.json` is the hook registry,
the directory is not — but it is **not a hook**: it reports failures via stderr and a
non-zero exit like the CLI it prefigures, and is exempt from the U2 no-stderr rule.

**Rejected:** Model `Edit` for snapshot-clear (cannot hold the concurrent-append
invariant; Edit on a changed file either fails or clobbers); deferring the helper to run
3's CLI (leaves run 2's integrate skill unable to honor the spec's own "inbox is never
lost" contract); a separate `bin/` directory (a second bundled output location for one
file — and run 3's CLI reuses the primitives, not this wrapper, so nothing is prefigured
wrongly).

### A16. Hook work is two-lane: the response lane is budgeted, the maintenance lane yields

Injection, pointers and capture must complete. Decay, queue claims and sweeps run only
when uncontended (first-attempt lock, ≤1 job) and skip silently otherwise — the next
session retries.

**Rejected:** Maintenance on the response path (the spec's own bounds compose to a 5 s
lock wait inside a <1 s budget); a background daemon (nothing in v1 owns a resident
process, and the durable queue exists precisely so short-lived processes can hand work
forward).

### A8 addition — hook-maintenance lock mode

A16 does not uphold A8's existing lock bound; it **adds a new named bound** to A8's
protocol family. A8's bound list now reads:

- Log rotation: 5 MB, keeping 1 prior generation
- Warning rate limit: 1 per hour per error code
- Lock retry (default lane): 50 × 100 ms then proceed lock-free
- **Lock retry (hook-maintenance lane): 1 attempt, then skip and defer to the next
  session** — the injection path must never sit inside a retry loop
- `index.lock` defer: retry 1 × then defer with no queue

**WORLD_MODEL check.** A12 upholds A1/A3/A9/A11/U2; A13 amends the run-1 cursor contract
(named amendment, raised at the gate); A14 extends A4; A15 upholds A2/A6; A16 upholds A2
and adds the bound above to A8. No entry of A1–A11 is contradicted.

---

## Run-2 Amendments

Twenty-eight amendments landed with run 2. Items 1–24 are the run-2 plan's triaged
design-review decisions and are recorded in full in
`docs/superpowers/specs/2026-07-28-mehmory-design.md` § *Run-2 amendments (2026-07-29)* —
including the three that change previously fixed contracts and were approved as such at
the gate: **2** (session-scoped capture state; global-cursor API removed), **10**
(UserPromptSubmit budget restated as <100 ms in-hook / <300 ms end-to-end) and **14**
(maintenance token allowance: ≤2 lines, 150 tokens, combined injection asserted ≤950).

Items 25–28 were discovered during implementation and are recorded here in full:

25. **Per-hook config shape.** Run 1's `hooks.SessionStart: boolean` is replaced by
    `hooks.<name>.enabled` objects with snake_case names (`session_start`,
    `user_prompt_submit`, `stop`, `pre_compact`, `session_end`), each defaulting to
    `{ "enabled": true }`. The object form leaves room for per-hook keys without a second
    shape change.
26. **Index line format mandated:** `- [[slug]] — one-line summary`, one line per page,
    the wikilink matching the page filename. The decay pass associates index lines to
    pages through that link — heuristically in run 2, via a `format.ts` constant in run 3.
27. **Archival drops the index line.** Moving a page into `archive/` removes its line from
    `index.md` entirely; the page stays greppable but leaves the catalog. Demotion below
    the `## Archive` divider, by contrast, keeps the line.
28. **`inbox-tx` is stateful; the library is not.** Snapshot-id → id-list mappings are
    persisted by the helper as `.state/inbox-snapshot.<id>.json` so `snapshot` and `clear`
    can be separate process invocations minutes apart. `src/core/inbox.ts` stays
    stateless and takes an explicit id list. `clear` consumes and deletes the mapping, so
    a replayed clear fails loudly instead of removing entries captured since.

---

## Architectural Decisions — Run 3

Established in run 3 (CLI, search, docs, CI). Binding on run 4.

### A17. The CLI is a second thin consumer, not a second implementation

`src/cli/` owns argument parsing, exit codes, stdout/stderr and the `--json` envelope;
every behavior lives in `src/core|schema|distill`. Extends A12 to the run's second
consumer, upholding A1. The core's `no-process-exit` and `no-stderr` rules gate on
`filename.includes('src/core/')` (`eslint-rules/index.js`), so the CLI needs no rule
change to exit or write stderr; a new import-boundary rule (`custom/no-cli-imports`)
keeps the dependency edge from inverting — `src/core/**` and `src/hooks/**` may never
import `src/cli/**`.

**Rejected:** a CLI reimplementing distill/inbox/decay logic (two implementations of the
product's core — the exact failure A12 exists against); CLI code under `src/hooks/`
beside `inbox-tx.ts` (that file is a skill helper, not a user-facing binary).

### A18. Search is one scan over pages + archive + log; there is no index

`src/core/search.ts` extends the landed matcher (`match.ts`) rather than adding a second
retrieval path. `matchPages()` keeps its existing signature and scope for the
`UserPromptSubmit` hook.

**Rejected:** FTS5 with a SQLite index (the spec's own original choice, declined at the
gate) — the degraded grep fallback would have had to exist regardless and `matchPages`
cannot reach `log.md`, so the index would have been a strict second implementation of a
scan the run had to write anyway; it also required a named exception to A3
(`node:sqlite` performs file I/O outside `fs.ts`, which the `fs`/`node:fs` lint rule
cannot catch), an index schema version, a cold-build bound, and a corruption path —
substantial machinery for a corpus the spec itself caps at ≤1500 tokens per page. The
spec's SessionEnd rebuild job specifically: `session-start.ts` filters `claimJob()` by
job type, so an `fts-rebuild` job would never be claimed at any `claims_per_start` value.
A resident indexer daemon (A16: nothing in v1 owns a resident process). *Deferred, with a
threshold* (not rejected outright): FTS returns when the scan measurably exceeds ~1s on a
real store, or the 2000-file scan cap fires often enough that `warnings` becomes routine.

### A19. mehmory deletes from the working tree and never rewrites the user's git history

`mehmory purge` removes files, commits the removal, and prints the `git filter-repo`
recipe for anyone who wants history rewritten too.

**Rejected:** built-in history rewriting — the honest reason is **tool dependency**
(`git filter-repo` must be detected or vendored, and a failed rewrite has no fail-open
answer), not "it's the user's repo to protect": the store repo is created by
`initStore()`, has no remote, and mehmory already overrides `commit.gpgsign` on it.
Silent working-tree deletion without disclosure (the privacy claim would then be false,
which is worse than stating the limitation).

### A20. Narrow, read-only carve-out on A4: `doctor` may read `schema_version`

`doctor` reads `schema_version` from the store's `SCHEMA.md`, compared against the
**embedded template constant in `store.ts`** — per the spec's drift-warning intent, not
against `FORMAT_VERSION`, which versions the machine format and would fire a warning
with no correct user action on every code-only bump. One key, read-only, warning-only.

**Rejected:** dropping the drift warning (it is the only upgrade signal the user gets —
see `docs/UPGRADE.md`); parsing `SCHEMA.md` generally (exactly what A4 forbids, and why).

### A21. Config is threaded, never ambient

Functions that need configuration take it as a parameter; no core function calls
`loadConfig()` internally. `buildInjection()` accepts the config and passes it to
`redact()`; one loader call per process or hook invocation.

**Rejected:** `loadConfig()` inside `redact()` (a disk read and `JSON.parse` in a
previously pure function called three times per injection, on the <1s `SessionStart`
path — the hot-path config re-read a reviewer already caught once in run 2).

### A22. Aged memory is demoted and flagged, never silently excluded

Retrieval never drops a page for age. A page past `decay.archive_days` is scored
×`STALE_SCORE_MULTIPLIER` (0.7); a page already moved into `archive/` is scored
×`ARCHIVED_SCORE_MULTIPLIER` (0.5), lower because archival is an explicit act rather than
mere drift. Both come back flagged `stale`, so `search` can print `[stale]` and the
`UserPromptSubmit` pointer can say `(stale)`. `status` reports the demoted and archived
counts. `log.md` is exempt: it records what happened, so it cannot become untrue.

Multiplicative, not the subtractive penalty the source system (memhub) uses, because
mehmory's scores are unbounded token-occurrence counts rather than a 0–1 blend —
subtracting a constant would erase a weak fresh hit while barely denting a strong stale
one. A page with no parseable `updated` is treated as fresh: unknown age is not evidence
of age, and the opposite reading would demote every hand-written page without frontmatter.

**Rejected:** excluding stale pages from retrieval (a stale answer beats no answer, and a
bad staleness default then hides valid memory with no way for the user to notice — demote
is the reversible posture); a config knob per multiplier (two calibration constants nobody
has yet had cause to tune — `decay.archive_days` already controls *when* demotion starts).

**WORLD_MODEL check.** A17 upholds A1/A12 and does not touch A3 (`src/cli/` uses the
existing `fs.ts` surface); A18 upholds A2/A3/A9/A16 — with FTS dropped there is no I/O
outside `fs.ts` and no sync/async question; A19 upholds A2; A20 is a **named, narrow
exception** to A4, recorded as such; A21 upholds A2 and A9; A22 upholds A4 (the
multipliers and the staleness predicate live in `schema/format.ts`, the format authority)
and A21 (`archive_days` is threaded in from the caller's config, never read inside
`match.ts` or `search.ts`). A11 is unthreatened: scoped to core by its own text.

**Amendment to A6.** `initStore()`'s owned layout grows: it now also creates, when
absent, `~/.mehmory/.gitignore` (containing `.state/`) and an **empty** `{}`
`config.json`. Ownership does not move — `src/core/store.ts` still owns `initStore()` —
the layout it owns just grows by two files.

**Note on A12's enforcement claim.** A12 (run 2) states the eslint boundary rules
`no-exported-promise`, `no-process-exit`, and `no-stderr` "extend to `src/hooks/`." In
practice, all three gate on `filename.includes('src/core/')` in
`eslint-rules/index.js` and **never fire in `src/hooks/`** — only the
`fs`/`no-cli-imports` boundary rules genuinely extend there. Consequently
`eslint.config.js`'s rule exemption carved out for `inbox-tx.ts` (A15's bundled helper,
which legitimately needs to write to stderr and exit non-zero) is a no-op: there was
never anything active in `src/hooks/` for it to exempt. This is latent, not a regression
from anything run 3 touched, and it is recorded here **so run 4 does not rediscover
it** — fixing the rule scope is explicitly out of scope for run 3.

**Licensing note.** `package.json` declared `license: MIT` before this run but shipped no
`LICENSE` file to back it — an undeclared gap, not a deliberate choice. Run 3 adds
`LICENSE` (MIT, confirmed by the user this run).

## Architectural Decisions — Run 4

Established in run 4 (Codex-host prefactor). Binding on later run-4 units.

### A23. Host is declared and threaded, never detected

Each harness's hook configuration passes its host as an argument on the command it
invokes; a single core module resolves it and threads it to callers. Environment
detection exists only as a fallback for a hand-written configuration. mehmory writes
both hook configurations itself, so it can always declare rather than infer. Extends
A21 (config is threaded, never ambient).

### A24. The transcript reader is the normalization boundary

Above the reader, distillation takes exactly one input type and is harness-blind, so the
distill patterns and their normative fixtures do not fork (A7). Below it, each harness's
on-disk shape is a parse detail and reader selection is by host. Adding a third harness
is a new reader, not a new distiller.

## Run-4 Amendments

### Amendment: A7 does not make the pattern list the whole capture contract

A7 fixes the distill patterns and their fixtures as a contract. It was read as saying the
pattern list decides what is captured. It never did: the list ends in a `user_message`
catch-all matching every user turn, so the patterns above it only chose a label, and no
part of the pipeline decided whether a turn was worth keeping. Real stores filled with
menu picks and acknowledgements; one held seven consecutive one-letter entries.

Amending: capture is **pattern selection plus a retention floor**, and the floor is as
normative as the patterns. It lives in `extractMessageText` so every pattern reaches its
text through it and none can opt out. A fixture that pins retention is as binding as one
that pins a pattern match.

The floor errs toward keeping, deliberately, and that direction is the contract rather
than the threshold's value. A memory tool that silently discards the user's own words
fails worse than one that files some junk: a junk entry is visible and deletable at
integrate time, a dropped fact leaves no signal anywhere. A later run may move the
threshold; it may not invert the direction without amending this.

A corollary the first attempt got wrong: the floor may not assume a script. Counting
whitespace-separated words encodes "words are separated by spaces", which is false for
Chinese, Japanese and Korean, and dropped complete sentences in those languages as a
single "word".

**Rejected:** Retention as a pattern (a `too_thin` pattern in the list would be tested in
order and skipped by any earlier match, which is exactly how the catch-all escaped
scrutiny). Retention as config (a threshold no one has needed to tune is a key to keep
working forever; the constant is one edit away if that changes).

**WORLD_MODEL check.** This amendment extends A7 and upholds A21 — the floor is a module
constant, not ambient state, and reads no environment.

### A25. Built hook bundles are committed on the default branch

`hooks/*.mjs` is build output, and it is committed anyway. The plugin marketplace resolves
`.claude-plugin/marketplace.json`'s `"source": "./"` by cloning this repo and copying the
**default branch** — not the release tag, not the npm tarball. Whatever `main` does not
carry, the installed plugin does not have.

The original arrangement gitignored the bundles on `main` and had `release.yml` force-add
them onto the `v*` tag. The tag was correct — `git ls-tree v0.3.0 -- hooks` lists all six
bundles — and it never mattered: installs recorded `main`'s HEAD, so `hooks.json`
registered five commands whose target files did not exist. Every hook died with
`MODULE_NOT_FOUND` and exit 1, which the host surfaces as a hook failure rather than as a
missing plugin, so the store simply stayed empty and silent.

This is the standard failure mode for a git-distributed plugin: the artifact the host
loads is the tree on a branch, so the branch is the distribution channel. npm is a second
channel with different mechanics (`files` + a `prepublish` build), and it was already
working; the two do not share an artifact path and cannot share one.

**Committed build output goes stale.** That is the real cost here, and it is paid in CI:
`ci.yml` rebuilds and fails if `git status --porcelain -- hooks/` is non-empty. The
bundles are content-addressed and reproducible — an independent tag build and a local
build produced identical `chunk-Q3XCVOKA.mjs` / `chunk-RODSLL2D.mjs` — so the check is
deterministic rather than flaky.

**Rejected:** *A dedicated release branch pointed at by `marketplace.json`* — moves the
same artifacts into a branch that no one reviews, and buys cleanliness on `main` at the
cost of a second publishing path to keep honest. *Building on install* — plugin hooks run
as bare commands with no install step, and a first-run `pnpm install` inside a hook is
both slow and a network dependency on the session-start path. *Shipping only via npm and
dropping the marketplace* — the marketplace install is the documented entry point and
requires no Node toolchain from the user.

**WORLD_MODEL check.** Upholds A12 (bundles stay thin adapters over `src/core`; committing
them changes distribution, not layering) and A17 (the CLI's `dist/` stays gitignored — it
reaches users through npm's `bin`, which the marketplace clone never provides).
