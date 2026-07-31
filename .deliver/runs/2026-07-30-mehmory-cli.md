# Run: mehmory-cli

mode: single
approved: 2026-07-31T02:37:27Z (rev 1, incl. two gate-raised contract changes: FTS5 dropped from v1; recall + contradiction KPIs unowned in v1)
landed: 2026-07-31T14:48:48Z
retroed: 2026-07-31T15:10:00Z
case_studied: false
session: db0f33c7-4f00-4a5a-9588-3dd7c48d4598
model: claude-opus-5
context_at_approval: same session as intake; plan frozen before the gate

Dispatches: 13 of 13 (execution envelope; intake-charged: 4 of 4 spent)

## Approved plan (rev 1)

approved: 2026-07-31T02:37:27Z

*Amendment round 1 of 2 applied: the fixes proposed by the contract, architecture and UX
reviewers, verbatim, plus the user's gate decision to drop FTS (see gap 1). Verdicts carry
forward bound to plan + these amendments; no re-review.*

# Plan: mehmory-cli

Run 3 of 3 delivering `docs/superpowers/specs/2026-07-28-mehmory-design.md` (approved v1,
all-in). Slicing fixed at run-1 intake: run 1 foundation (landed, PR #1), run 2 hooks +
skills + plugin packaging (landed, PR #2), **run 3 CLI + search + docs + CI (this plan)**.
Three intake confirmations: (a) the CI publish job is written but **inert** — gated on a tag
plus a secret added later, nothing publishes outward during the run; (b) the spec's TTHW
≤5 min release gate is proven by an automated scripted quickstart test against a fresh temp
`MEHMORY_HOME`, not by a live plugin install; (c) **FTS5 is dropped from run 3** and
`search` ships on one scan — a scope reduction against a spec-fixed component, decided by
the user at the gate (gap 1).

## Problem

The plugin works and nothing outside a Claude Code session can see it. There is no way to
create a store deliberately, no way to search what was captured, no way to find out why a
hook stopped firing, no way to delete anything, and no way for a new user to get from
`git clone` to a working memory — the spec's entire "First 5 Minutes" flow (`spec:315`) has
no executable behind it. Nothing is publishable: `package.json` has no `bin`, no `files`, no
`engines`, no repository metadata, and every hook bundle the plugin needs is gitignored, so
a tag today would ship a `hooks.json` pointing at five files that are not in the repo.

The run-3 surface is also the least-maintained part of the spec. Four review dispatches
(spec adversary, contract, architecture, UX) returned 5 BLOCKER / 32 MAJOR / 17 MINOR
against it: two documented escape hatches that are dead config keys, a KPI table item 32
promised to sync and never did, an FTS rebuild job no shipped code can claim, a `purge
--session` that reaches only the least-sensitive copy, a `purge --all` with no confirmation
token defined, and an empty-store hook nudge that fires *after* a successful `onboard` and
points the user at a rival command. All are triaged in `## Spec gaps and inferences` and
land as the spec's `## Run-3 amendments`.

## Done when

Each criterion is checkable by a command a verifier runs itself. CLI tests spawn the
**built** `dist/cli.mjs` as a subprocess against a temp `MEHMORY_HOME` and a temp fake
`~/.claude` — never the real ones. Every command has at least one **positive-path** test
asserting real output, not just an exit code.

1. **Gates:** `pnpm install && pnpm build && pnpm lint && pnpm test && pnpm typecheck` all
   exit 0 from a clean clone, and `.husky/pre-commit` still runs lint + test + typecheck.
   The verifier proves the gate itself by committing a type error on a temp branch,
   asserting rejection, and cleaning up.
2. **CLI framework and exit codes:** `dist/cli.mjs` is a single self-contained ESM bundle
   (`splitting: false`, and `!src/cli/**` excluded from the library entry so CLI internals
   never ship as importable surface — the A17 parallel to `!src/hooks/**`), invoked as
   `mehmory` via `package.json` `bin`. Exit codes, asserted per command: **0** success,
   **1** usage error (unknown command/flag/arity, ambiguous selector), **2** store missing
   where required, **3** operation failed (write/git failure), **4** aborted by the user.
   `doctor` additionally uses **5** (warnings only) and **6** (at least one error-level
   finding) and **never exits 2** — a missing store is the finding it exists to report, so
   it exits 6 naming `mehmory init` as the remedy. `--help`, `<cmd> --help` and `--version`
   exit 0. Command registration: `src/cli/index.ts` imports a `command` export from each
   file in `src/cli/commands/`; **C1 lands every command file as a stub plus the complete
   registry against criteria 4–11's frozen list**, and S/C2 fill in only their own file
   bodies — no unit edits another's file.
3. **`--json` envelope:** every `--json` invocation emits exactly one line of
   `{"schema":1,"command":"<name>","ok":<bool>,"data":{…},"warnings":[…],"errors":[…]}` on
   stdout and nothing else. `errors[]` elements are `{code, what, consequence, fix?}` — the
   landed `MehmoryError` fields minus the `Details:` path — so a model can reach the code
   and the command without parsing prose. **When `--json` appears anywhere in argv, usage
   errors emit the envelope with `ok:false` on stdout and exit 1** (a pre-command parse
   failure must not be the one path that returns a different format). `CLI_JSON_SCHEMA`
   lives in `src/cli/`, not `src/schema/format.ts` — it versions a CLI transport envelope,
   not the wiki format A4 governs. Tested on both the success and the failure path.
4. **`init`:** idempotent, calls run-1 `initStore()` (A6 preserved) and additionally writes,
   when absent, `~/.mehmory/.gitignore` containing `.state/` and an **empty `{}`**
   `config.json` — empty, not fully-defaulted, so that `E_CONFIG_PARSE`'s own `Fix:` opens a
   file that exists without materializing every default onto disk where a later default
   change would become a silent no-op (the shadow-defaults failure A4 rejects). Checks the
   Node version against `engines`, verifies the plugin is installed by a concrete filesystem
   probe and prints the pinned install command when absent, and ends with the next step —
   prefixed "in a Claude Code session, run …" for the slash commands, since `init` runs in a
   shell where they do nothing. Running it twice changes nothing (asserted by byte-comparing
   the store tree).
5. **`onboard`:** `mehmory onboard [--project [<key>]|--global] [--dry-run] [--sessions N]
   [--max-bytes N] [--projects N] [--resume]`. Scans `~/.claude/projects/*/`, decodes each
   path-encoded directory back to a filesystem path, resolves the key by running
   `resolveProjectKey()` **in that path**, and lists projects with session counts and sizes;
   a directory whose decoded path is gone is listed `unresolvable` and skipped, never
   guessed. The scan is capped at `--projects` (default 50), listing the remainder as
   unscanned — it spawns git per uncached directory and the directory count is user-sized.
   Distills recent-first with caps (default 30 sessions / 500 KB), redacts, and appends via
   `appendInboxEntries()` so replay is a no-op by id. **A non-dry-run `onboard` also writes a
   one-line stub `project.md` for the target scope**, so `storeIsUnpopulated()` is false and
   the next SessionStart does not tell the user their memory is empty and point at
   `/mehmory:onboard-session` — the hook string stays untouched (criterion 19) and stops
   contradicting the CLI. **Zero usable transcripts exits 0** printing "no transcripts found
   — run `/mehmory:onboard-session` inside a Claude Code session in your project instead".
   `--dry-run` writes nothing (asserted by hashing the store tree before and after).
   `--resume` resolves the same scope flags as the interrupted run and exits 1 if the state
   file's recorded scope differs; reaching `done` deletes the state file. A test kills
   mid-run and asserts `--resume` produces the same final inbox as an uninterrupted run.
6. **`search`:** `mehmory search <query> [--project [<key>]|--global|--all] [--limit N]
   [--json]`. Scans **pages + archive + log** of the selected scopes and returns ranked hits
   as `{path, scope, score, snippet}`; `--limit` defaults 10, caps at 100. The scan is
   bounded by a file cap (default 2000); over it, the newest files are scanned, `warnings`
   says so, and the command still succeeds. Exit 0 with results, exit 0 with an empty result
   set (a query matching nothing is not an error), exit 2 when the store is absent. Tests
   assert ranking beats naive substring order on a fixture corpus and that `--limit` and the
   file cap genuinely truncate.
7. **One matcher, extended (resolves BLOCKER 1 and the FTS decision):** `src/core/search.ts`
   extends the landed `match.ts` scoring to a multi-corpus scan — pages and archive as
   directories, `log.md` as a line-oriented file — returning scores and snippets.
   `matchPages()` keeps its current signature and behavior for the hook (criterion 19); the
   scan is the only search implementation in the product. **No sqlite, no index file, no
   rebuild job, no staleness or corruption lifecycle, no capability probe.** The spec's
   SessionEnd rebuild leg is deleted, not deferred. FTS5 is recorded as deferred behind a
   named measured threshold (see the judgment entry).
8. **`doctor`:** `mehmory doctor [--json]` runs a fixed check list — Node version against
   `engines`, store dirs, git health (`.gitignore` present, tree clean, last commit), plugin
   hooks registered, **per-hook `enabled` config state (warn, naming the key, when any hook
   is disabled — run-2 amendment 17 assigned this resurfacing to run 3's doctor)**, hook
   liveness from `stats.jsonl`, inbox count + age, last integrate from `log.md`, `errors.log`
   tail, `schema_version` drift, config parseability, and KPI budget violations against the
   **amended** numbers (criterion 16). Every finding is `ok | warn | error`; every one with a
   real remedy carries a copy-paste command. Exit 0/5/6. Tests break each check in turn
   (remove `.gitignore`, stale stats, unparseable config, drifted `schema_version`, disabled
   hook, absent store) and assert the specific finding and exit code.
9. **`status`:** `mehmory status [--json]` — scope and resolved key, page count, index line
   count, inbox entries + age of oldest, last integrate, last commit, and pending warnings
   read **non-destructively** via a new `peekWarnings()`. `pendingWarnings()` returns and
   clears, and is SessionStart's only warning channel; a test asserts `status` run twice
   still leaves the warning pending for a SessionStart fixture.
10. **`stats`:** `mehmory stats [--project [<key>]|--global|--all] [--since <iso>] [--json]`
    aggregates only fields that exist: per-hook counts, `ms` p50/p95, injection tokens
    p50/p95, pointers offered, captured entries — plus inbox age from `inbox.md` mtime and
    integrate cadence from `log.md`. The spec's un-sourced aggregations are cut, not faked.
    Percentile arithmetic asserted against a hand-computed fixture.
11. **`purge`:** `mehmory purge <page-slug> | --session <id> | --project [<key>] | --global |
    --all`, with `[--dry-run] [--export <path>] [--yes]`. `--global` is a scope in its own
    right — `identity.md` and `global/pages/` are the most personal content in the store and
    must not require nuking every project to reach. Preview, then a **typed token pinned per
    form**: `--all` → the literal `DELETE ALL`; `--project` → the **resolved** key echoed in
    the preview, never the substring the user typed; `--session` → the last 8 characters of
    the id as shown in the preview; `--global` → `global`; a page → its slug. A bare page
    slug resolving in more than one scope exits 1 listing candidates, never deletes both.
    Wrong token exits 4 changing nothing; `--yes` skips the prompt; `--export` copies targets
    first and aborts (exit 3) if the export fails. Purge deletes from the working tree and
    commits; **if the commit fails the files are already gone** — that terminal state exits 3
    naming the dirty store and `git -C ~/.mehmory commit -a` as the remedy, and a test forces
    it. Purge **never rewrites git history**; the command's own output (not only the docs)
    says so and prints the `git filter-repo` recipe. `--session` is explicitly scoped to
    un-integrated inbox entries — the only place `src=<sessionId>` survives — stated in
    `--help`, in output, and in the docs.
12. **Scopes: one helper, one grammar (resolves MAJOR 12 and the flag divergence):**
    `src/core/scopes.ts` discovers projects as any directory under `projects/` containing
    `inbox.md` (keys are 2–5 path segments, so a flat `listDir` is wrong) and **resolves
    `config.identity.aliases` sources to their targets before matching**, so a user who
    aliased a key can still name it. `--project [<key>]` is optional-valued in **all four**
    scope-taking commands (bare = the current directory's resolved key), and `--global` /
    `--all` are accepted by all four; a command that cannot act on a given scope rejects it
    with exit 1 rather than not parsing it. A key or unique substring matches; ambiguity
    exits 1 listing candidates. Nested keys prune empty parents on purge.
13. **Dead config keys resolved, not documented (resolves BLOCKER 3):**
    `injection.budget_tokens` reaches `buildInjection()` and `secrets.patterns`/`whitelist`
    reach `redact()` — **threaded as a parameter, never ambient**: config is loaded once per
    process/hook invocation and passed down, so no core function acquires a disk read
    (`redact()` is called three times per injection on the <1 s SessionStart path).
    Malformed user patterns are logged and skipped, never thrown, and the hardcoded patterns
    always remain in force. A new `stop` config group carries `capture_threshold`. Each key
    is proven by a test that sets a non-default value and observes changed behavior — a
    documented knob that changes nothing is worse than an absent one.
14. **Error registry and the fix-quality audit (resolves MAJOR 2):** new codes registered for
    the surfaces run 3 adds (search failure, onboard read failure, purge failure, transcript
    directory unresolvable, at minimum), each with its kind. **Every existing
    `kind: 'actionable'` call site is audited**: any whose `fix` is not a runnable command is
    reclassified `informational` — today `hook.ts:112` ("See ~/.mehmory/.state/errors.log"),
    `store.ts:103` and `fs.ts:215` ("Check file permissions and disk space") all fail U10,
    and `failOpen` synthesizes a fourth. Actionable fixes interpolate the **resolved** path
    (`store.ts:89` hardcodes `~/.mehmory` under a documented `MEHMORY_HOME` override).
    CLI-originated errors skip `recordWarning()` via a module-level CLI-mode flag inside
    `errors.ts`, set by `src/cli/index.ts` at startup — `logError` calls `recordWarning`
    unconditionally at `errors.ts:127` and has 17 call sites across 10 files, so a threaded
    parameter would touch all of them, and A17 forbids `src/core/**` importing `src/cli/**`.
15. **Docs:** `README.md` ("First 5 Minutes", numbered, expected output per step);
    `docs/CLI.md` (every flag, default, exit code, plus one sentence on why `mehmory search`
    and in-session pointers answer differently); `docs/TROUBLESHOOTING.md` indexed by the
    **stable** `MEHMORY E_<CODE>` prefix and the verbatim `consequence` sentence, stating
    that the variable `what` segment is skipped — the runtime V8/libuv text a user actually
    reads is not greppable and an index built on it would pass its own test while failing the
    user; `docs/PRIVACY.md` (secret filter's documented limits, what purge does and does not
    reach, the git-history recipe, **the uninstall-vs-data-deletion distinction and the
    restore procedure for `--export`**, with a README pointer); `docs/CONFIG.md` (all
    **14** groups with real defaults, marking any key not honored); `docs/UPGRADE.md`
    (`schema_version` drift). The README's integrate step states the permission prompt is
    expected and that denial is safe (entries wait in the inbox), and the flow is ordered so
    no step promises knowledge the injection path cannot yet deliver — `project.md` reaches a
    session only after integrate, so "the session already knows the project" is the *second*
    session, and the README says so.
16. **KPI table synced — GATE-RAISED (resolves MAJOR 1):** the spec's KPI table is rewritten
    once, in place, to the amended numbers (run-2 amendments 10 and 14, run-1 amendment 8,
    addendum items 14/32), the TTHW row carries "measured over the CLI steps; the session and
    integrate steps are fixture-asserted", and the recall (≥70% top-3) and contradiction
    (0 after lint) KPIs are marked **unowned in v1**. Those two are auto-approved spec
    content, not undefined gaps — dropping them from v1 ownership is a contract change, and
    approving this plan approves it.
17. **TTHW gate is a scripted test with stated reach:** `test/quickstart.test.ts` runs the
    documented flow against a fresh temp `MEHMORY_HOME` and fake `~/.claude` —
    install-equivalent, `init`, `onboard --dry-run`, `onboard`, `search` — asserting each
    step's documented output and total wall time under budget. The two model-driven steps are
    asserted **by fixture, not by execution**, and criteria 15 and 16 both carry that caveat
    where the user reads it. **Owned by the integration unit, not X** (it spawns
    `dist/cli.mjs`, which does not exist until S+C1+C2 merge).
18. **Distribution pinned (resolves BLOCKER 2):** `package.json` gains `bin`
    (`mehmory` → `dist/cli.mjs`), `files`, `engines` (`node >=22`), `repository`, `license`,
    and keeps its **root export pointed at the library, not the CLI bundle**.
    `.claude-plugin/plugin.json` gains marketplace metadata. `.github/workflows/ci.yml` runs
    install/build/lint/test/typecheck on push and PR. `.github/workflows/release.yml`
    triggers on a `v*` tag, builds, and force-adds the built `hooks/*.mjs` into the tagged
    tree so a marketplace install gets a plugin whose `hooks.json` references files that
    exist. The publish job is **inert**: a test asserts its `if:` names both the `v*` tag ref
    and `secrets.NPM_TOKEN`, and no tag is cut.
19. **Hooks: exactly two permitted edits.** `src/hooks/stop.ts` (reads
    `stop.capture_threshold` from config) and `src/hooks/inbox-tx.ts` (config-aware
    `redact()` call site) are the only hook files this run may touch, both owned by L. Any
    other hook diff fails the criterion — `git diff --stat src/hooks/ hooks/` is checked
    against that exact list, so the criterion can fail mechanically rather than by a
    verifier's judgment. The UserPromptSubmit pointer path keeps `matchPages` over the
    current scope's live pages.
20. **Fail-open, hermeticity, and boundary enforcement:** the CLI may exit non-zero (that is
    its contract), but no CLI path throws an unhandled exception — fixtures with a corrupt
    store, an unreadable transcript, a store path that is a file, and a corrupt store `.git`
    each produce a templated error and a documented exit code. No test reads or writes the
    real `~/.mehmory` or `~/.claude`, subprocess env included (`test/setup.ts` already
    documents that a parent-process guard cannot see a child).
21. **The A17 boundary is lint-enforced, not asserted:** `eslint-rules/` gains an
    import-boundary rule forbidding `src/core/**` and `src/hooks/**` from importing
    `src/cli/**`, and a test asserts the rule fires on a fixture. Every other boundary in
    this repo (A3, A9, A11, U2) is backed by a rule; an architectural invariant that ships as
    prose can be skipped with every criterion green.
22. **Spec amendments and ADRs landed:** the spec gains `## Run-3 amendments` (the triage
    below); `docs/WORLD_MODEL.md` gains A17–A21 plus the amendment list, **including the
    recorded note that A12's enforcement claim is aspirational** — `no-process-exit`,
    `no-exported-promise` and `no-stderr` all gate on `src/core/` and never fire in
    `src/hooks/`, so the `eslint.config.js` exemption for `inbox-tx.ts` is a no-op. Latent
    today; recorded so run 4 does not rediscover it. `AGENTS.md` gains the run-3 structure
    and ownership.

## In scope / Out of scope

**In scope:** the 7 CLI commands and their framework, the multi-corpus scan, scope
resolution, the library fixes the CLI forces (config threading, error codes + fix audit +
CLI-mode flag, `peekWarnings`, `initStore` gitignore/config, index-line format constant),
the import-boundary lint rule, the docs set, the CI workflows, the scripted quickstart test,
and the run-3 spec amendments + ADRs.

**Out of scope:** FTS5, `node:sqlite`, and any search index (dropped at the gate, deferred
behind a named threshold); any hook change beyond the two named in criterion 19; the dogfood
eval harness and the labeled recall query set (unowned in v1, criterion 16); embeddings, MCP,
team features (spec non-goals); actually publishing (inert — no tag, no secret); installing
the plugin into the user's live config; rewriting git history in the user's store (A19).

## Architecture

**A17. The CLI is a second thin consumer, not a second implementation.** `src/cli/` owns
argument parsing, exit codes, stdout/stderr and the `--json` envelope; every behavior lives
in `src/core|schema|distill`. Extends A12 to the run's second consumer, upholding A1. The
core's `no-process-exit` and `no-stderr` rules gate on `filename.includes('src/core/')`
(`eslint-rules/index.js:42,137`), so the CLI needs no rule change to exit or write stderr,
and criterion 21 adds the rule that keeps the dependency edge from inverting.
*Rejected:* a CLI reimplementing distill/inbox/decay logic (two implementations of the
product's core — the failure A12 exists against); CLI code under `src/hooks/` beside
`inbox-tx.ts` (that file is a skill helper, not a user-facing binary).

**A18. Search is one scan over pages + archive + log; there is no index.** `src/core/search.ts`
extends the landed matcher rather than adding a second retrieval path.
*Rejected:* **FTS5 with a SQLite index (the spec's own choice, declined at the gate)** — the
degraded fallback would have had to exist anyway and `matchPages` cannot reach `log.md`, so
the index would have been a strict second implementation of a scan the run must write
regardless; it also required a named exception to A3 (`node:sqlite` performs file I/O
outside `fs.ts`, which the `fs`/`node:fs` lint rule cannot catch), an index schema version,
a cold-build bound, and a corruption path — substantial machinery for a corpus the spec
itself caps at ≤1500 tokens per page. The spec's SessionEnd rebuild job — rejected twice
over: `session-start.ts:38` filters `claimJob('distill-final')` by type, so an `fts-rebuild`
job would **never be claimed at any `claims_per_start` value**. A resident indexer daemon
(A16: nothing in v1 owns a resident process). *Deferred, with a threshold:* see the judgment
entry — FTS returns when the scan measurably stops being enough.

**A19. mehmory deletes from the working tree and never rewrites the user's git history.**
Purge removes files, commits the removal, and prints the `git filter-repo` recipe.
*Rejected:* built-in history rewriting — the honest ground is **tool dependency** (`filter-repo`
must be detected or vendored, and a failed rewrite has no fail-open answer), not "a repo the
user configured": the store repo is created by `initStore()`, has no remote, and mehmory
already overrides `commit.gpgsign` on it. Silent working-tree deletion without disclosure
(the privacy claim would be false, which is worse than the limitation).

**A20. Narrow, read-only carve-out on A4: `doctor` may read `schema_version` from the store's
SCHEMA.md**, compared against the **embedded template constant in `store.ts`** — per
`spec:193` ("drifts behind the plugin's template version"), *not* against `FORMAT_VERSION`,
which versions the machine format and would fire a warning with no correct user action on
every code-only bump. One key, read-only, warning-only.
*Rejected:* dropping the drift warning (addendum item 12 is the only upgrade signal the user
gets); parsing SCHEMA.md generally (exactly what A4 forbids, and why).

**A21. Config is threaded, never ambient.** Functions that need configuration take it as a
parameter; no core function calls `loadConfig()` internally. `buildInjection()` accepts the
config and passes it to `redact()`; one loader call per process or hook invocation.
*Rejected:* `loadConfig()` inside `redact()` (a disk read and `JSON.parse` in a previously
pure function called three times per injection, on the <1 s path — the hot-path config
re-read Copilot already caught once in run 2).

**Amendments to existing ADRs.** A6: `initStore()` additionally owns `~/.mehmory/.gitignore`
and an empty `config.json` — ownership does not move, the layout it owns grows.
**ADR candidate recorded with criterion 18:** built plugin bundles are tag-only artifacts,
never on a branch. *Rejected alternatives:* committing bundles on `main` (the repo then
carries two truths about whether `hooks/*.mjs` is source or artifact); resolving the
marketplace install from the npm tarball via `files` (couples plugin distribution to an npm
publish that is inert this run).

WORLD_MODEL check: A17 upholds A1/A12 and does not touch A3 (`src/cli/` uses the existing
`fs.ts` surface); A18 upholds A2/A3/A9/A16 — with FTS dropped there is no I/O outside
`fs.ts` and no sync/async question; A19 upholds A2; A20 is a **named, narrow exception** to
A4, recorded as such; A21 upholds A2 and A9. A11 is unthreatened: scoped to core by its own
text. A17–A21 are ADR candidates recorded at landing.

## UX

Intended users: a Claude Code power user at a terminal, and the model invoking the CLI
through Bash. Both read the same output; only the second reads `--json`.

**U9. One output contract per invocation.** Human text by default, a single envelope line
when `--json` is asked for — including on usage errors, which are the one path that would
otherwise return a different shape. Errors go to stderr in text mode and into `errors[]` as
`{code, what, consequence, fix?}` in JSON mode. *Rejected:* pretty output with an embedded
JSON blob; per-command ad-hoc shapes (a model would need a schema per command).

**U10. Every surfaced error is the U1 template, and every `Fix:` is a real command.** Codes
with no runnable remedy are `informational` and omit the clause rather than printing "see
errors.log", which is not a fix — three landed call sites do exactly that today and criterion
14 reclassifies them. `doctor` prints the same commands; `docs/TROUBLESHOOTING.md` is indexed
by the stable parts of the message, and says which part is variable.
*Rejected:* inventing a plausible fix per code (the failure run-1 amendment 16 rejected once,
re-entering through `failOpen`).

**U11. Destruction is preview-first and typed, with the token scaled to the blast radius.**
`--all` requires the literal `DELETE ALL`; a project requires its resolved key; a session
requires the last 8 characters of its id; a page requires its slug. The output states in the
command itself that git history retains the content, and shows the recipe.
*Rejected:* a `y/N` prompt (one keystroke from irreversible on `--all`); a single token form
for every scope (the least destructive scope would have demanded the longest string, which is
how friction ends up inverted against risk).

**U12. Search is one path, so there is nothing to degrade.** Dropping FTS removes the
degraded/full split entirely: every user gets the same corpus and the same result shape.
*Rejected:* two retrieval paths with a `degraded` flag (a shape test asserts shape, not
corpus, so a fallback silently searching a third less of the store would have passed).

**U13. The first run tells you what to do next, and the product never contradicts itself.**
`init` ends with the next command, prefixed for the shell reader ("in a Claude Code session,
run …"); `doctor` ends with the highest-priority remedy; `onboard` with no transcripts sends
the user to `/mehmory:onboard-session` by name. Because `onboard` now writes a stub
`project.md` (criterion 5), the empty-store nudge no longer fires at a user who just
onboarded. The docs state which surface is canonical: CLI `onboard` mines existing
transcripts (cold start), `onboard-session` surveys the current repo in-session (the
no-transcripts path). *Rejected:* reconciling the two surfaces in documentation alone — the
user reads the hook, and the hook wins.

## Subtasks

Serial: **L** unlocks everything (it changes library signatures the others call and owns
build/packaging config). Then **S**, **C1**, **C2**, **X** in parallel against the contract
frozen in criteria 2–3 and the command list in criteria 4–11.

- **L — library + packaging.** Config threading (`injection.budget_tokens`,
  `secrets.patterns`/`whitelist`, new `stop.capture_threshold`) **plus the two permitted hook
  call-site updates it forces** (`src/hooks/stop.ts`, `src/hooks/inbox-tx.ts` — criterion 19);
  error-registry additions, the actionable-fix audit, `peekWarnings()`, the `errors.ts`
  CLI-mode flag; `initStore` gitignore + empty config; index-line format constant in
  `format.ts` with `decay.ts` switched onto it (run-2 amendment 26); `src/core/scopes.ts`
  (discovery + alias resolution); the `eslint-rules/` import-boundary rule and its fixture
  test; `package.json` (`bin`/`files`/`engines`/`repository`/`license`, root export left on
  the library) and `tsup.config.ts` (CLI bundle entry, `splitting: false`, `!src/cli/**`
  excluded from the library entry); plus the shared test infrastructure the others consume
  (temp-`~/.claude` fixture helper, hermetic guard for CLI subprocesses).
  → criteria 1, 12, 13, 14, 19, 20 (hermetic half), 21, 18 (package.json half).
- **S — search.** `src/core/search.ts` (multi-corpus scan, scoring, snippets, file cap) and
  `src/cli/commands/search.ts` body, plus tests. → criteria 6, 7.
- **C1 — CLI framework + read commands.** `src/cli/index.ts` (parsing, exit codes, envelope,
  help/version, **the complete command registry plus stub files for every command**),
  `init`, `doctor`, `status`, `stats`, and tests. → criteria 2, 3, 4, 8, 9, 10.
- **C2 — write commands.** `onboard` (dry-run, resume, project cap, stub `project.md`,
  zero-transcript path) and `purge` (scopes, tokens, export, commit-failure path), plus
  `src/core/onboard.ts` for the transcript-dir→key mapping, and tests.
  → criteria 5, 11, 20 (fail-open half).
- **X — docs, CI, amendments.** README, `docs/{CLI,TROUBLESHOOTING,PRIVACY,CONFIG,UPGRADE}.md`,
  `.github/workflows/{ci,release}.yml`, `.claude-plugin/plugin.json` metadata, the spec's KPI
  rewrite and `## Run-3 amendments`, `docs/WORLD_MODEL.md` A17–A21, `AGENTS.md`.
  → criteria 15, 16, 18 (workflows + plugin.json half), 22.
- **Integration unit.** Merges the tails and owns the two tests that cannot pass inside any
  parallel worktree because they spawn `dist/cli.mjs`: the bidirectional docs↔binary
  consistency test (every command and flag in `docs/CLI.md` ↔ `--help`; every `ERROR_KINDS`
  key ↔ `docs/TROUBLESHOOTING.md`; every `MehmoryConfig` top-level key ↔ `docs/CONFIG.md`)
  and `test/quickstart.test.ts`. X ships the docs; the tests that keep them honest land here.
  → criteria 15 (enforcement half), 17.

Unlock conditions: L merged to the run branch → S, C1, C2, X in parallel → integration.

## Dispatch shape

`swarm` — five units, four genuinely parallel after L, disjoint file sets (the registry
convention in criterion 2 is what makes them disjoint). Solo would serialize five independent
surfaces behind one context. Every worker in a worktree, never the main checkout.

## Spec gaps and inferences

All 25 spec-stage findings plus the three plan-stage reviewers' findings are triaged; each
lands in the spec's `## Run-3 amendments`. Items 1–4 resolve the spec-stage blockers.

1. **FTS5 dropped — GATE-RAISED, USER DECISION.** The spec names two mutually exclusive
   rebuild triggers (`spec:122` vs `spec:183`) and the SessionEnd leg has no claimant —
   `session-start.ts:38` filters by job type, so the job would never be claimed at any
   config value. On review, the deeper problem was that `matchPages` cannot search `log.md`,
   so a multi-corpus scan had to be written regardless and FTS became a second
   implementation. Amend: `search` ships on one scan; FTS5 and the rebuild job are removed
   from v1 and deferred behind the threshold in the judgment entry. **This drops a
   spec-fixed component; the user decided it at intake.**
2. **Distribution artifact (BLOCKER 2).** The release workflow force-adds built `hooks/*.mjs`
   into the tagged tree (recorded as an ADR candidate with its alternatives); `package.json`
   pins `bin`/`files`/`engines`/`repository`/`license`; `.claude-plugin/plugin.json` carries
   marketplace metadata. Publish stays inert.
3. **Dead escape hatches (BLOCKER 3).** `injection.budget_tokens` and
   `secrets.{patterns,whitelist}` are wired — threaded, not ambient (A21) — rather than
   documented as a lie or deleted. `stop.capture_threshold` joins them as a 14th group.
4. **Purge semantics (BLOCKER 4).** Working-tree delete + commit, never a history rewrite
   (A19), recipe printed in the command's own output; `--session` limited to un-integrated
   inbox entries and said so in three places; `--global` added as a scope; tokens pinned per
   form; the commit-failure state given an exit code and a test.
5. **KPI table sync — GATE-RAISED.** Addendum item 32 was never applied and run-2 amendments
   10/14 amended numbers the table still contradicts. Amend: rewrite once; TTHW row carries
   its measured reach; **recall (≥70% top-3) and contradiction (0 after lint) are dropped
   from v1 ownership** — auto-approved spec content, so approving this plan approves the
   change, in the same form run 2 used for its items 2/10/14.
6. **Run-3 error codes, the `failOpen` hole, and the actionable-fix audit (MAJOR 2).**
7. **Node capability (MAJOR 3).** With `node:sqlite` gone the fts5-vs-version distinction
   dissolves; `engines` plus an `init`/`doctor` version check is the whole requirement.
8. **Onboard's transcript-dir mapping (MAJOR 4)** — decode → `resolveProjectKey` in that
   directory → skip-and-list when gone; scan capped at `--projects`.
9. **Two onboarding surfaces (MAJOR 5)** — CLI `onboard` canonical for cold start;
   `onboard-session` for the no-transcripts path; **the contradiction is fixed in code**
   (stub `project.md`), not in prose.
10. **Pointer corpus unchanged (MAJOR 6).** The hook keeps `matchPages`; `search` uses the
    wider scan. The spec's **Eng review addition 22** ("full-text pointer matching",
    `spec:186`) is amended to "search scans pages+archive+log; pointer matching keeps the
    single-directory scan", with the reason recorded.
11. **Stats cut to their sources (MAJOR 7).**
12. **Store `.gitignore` (MAJOR 8)** — without it `git status` is never clean and doctor's
    crash signal is meaningless.
13. **A4 carve-out compares against the template constant, not `FORMAT_VERSION` (MAJOR 9).**
14. **`init`'s plugin check (MAJOR 10)** — a concrete filesystem probe plus the pinned
    install command.
15. **TTHW reach (MAJOR 11)** — stated in the KPI row and the README, not only in the plan.
16. **Project discovery, alias resolution, and one scope grammar (MAJOR 12 + UX M5).**
17. **`config.json` is written empty (architecture M1)** — a fully-defaulted file on disk
    pins every default forever and makes future changes silent no-ops.
18. **Config documentation covers all 14 groups**, marking any unhonored key.
19. **`peekWarnings()` (m2)** — `status`/`doctor` must not consume SessionStart's channel.
20. **CLI errors do not raise session warnings (m3)** — via a CLI-mode flag in `errors.ts`,
    not 17 call-site changes.
21. **CLI is one bundled file, `splitting: false`, excluded from the library entry (m4/m5).**
22. **`CLI_JSON_SCHEMA` lives in `src/cli/` (architecture M8)** — it is not wiki format.
23. **Usage errors honor `--json` (UX M3); `errors[]` element shape pinned (UX M4).**
24. **`doctor` gains the config-disabled-hook check (UX M10)** — the resurfacing surface
    run-2 amendment 17 explicitly assigned to run 3.
25. **Index-line format constant (m8)** — run-2 amendment 26's run-3 assignment.
26. **A12's enforcement claim is aspirational (architecture m1)** — three of its four named
    rules never fire in `src/hooks/`; recorded so run 4 does not rediscover it.
27. **README ordering is honest about when the magical moment lands (UX M1)** — `project.md`
    reaches a session only after integrate.
28. **Permission-denial fork documented in the README's integrate step (UX M11).**
29. **Uninstall-vs-purge and the `--export` restore procedure live in `docs/PRIVACY.md` with
    a README pointer (UX m2)** — uninstalling is not upgrading.

## Envelope

- `dispatch_budget`: **13** = 5 execution workers (L, S, C1, C2, X) + 1 integration unit +
  1 verifier + 2 fix attempts + 2 reserved for landing-stage review findings and re-verify +
  2 spare.
- `usage_budget_hours`: **4**.
- Intake-charged (not counted above): 4 review dispatches — spec adversary, contract,
  architecture, UX. All 4 spent.
- Experiments: 0 used, 2 available.

## Stages

- **Intake depth:** ambient (crisp — approved spec, slicing fixed at run 1). Three questions
  asked and answered: run-3 scope (all-in, publish inert), the TTHW gate (automated proxy),
  and the FTS call (dropped, at the gate, on the reviewers' evidence).
- **Architecture design:** `fired` — clauses 1 (new boundary `src/cli/`), 2 (new edges
  cli→core), 3 (shared scope-discovery abstraction consumed by four commands), 4 (A20 is a
  named exception to A4; A17–A19, A21 newly established).
- **UX design:** `fired` — clauses 1 (flags, exit codes, `--json`, error text), 2 (`bin` name
  and invocation contract), 3 (purge's preview→typed-confirm→execute walkthrough).
- **Design review:** spec stage `fired`, complete — 4 BLOCKER / 13 MAJOR / 8 MINOR / 5 PASS.
  Plan stage `fired`, complete — three fresh dispatches: contract 1 BLOCKER / 12 MAJOR /
  9 MINOR / 8 PASS; architecture 2 BLOCKER / 8 MAJOR / 4 MINOR; UX 2 BLOCKER / 12 MAJOR /
  4 MINOR. Amendment round 1 of 2 applied as exactly the reviewers' proposed fixes → verdicts
  carry forward bound to plan+amendments, no re-review. Evidence in `## Design review`.
- **Experiment stage:** not fired — no contested finding survived a debate round; the FTS
  disagreement resolved at the gate by the user, not by an experiment.
- **Dispatch shape:** swarm, 5 units + integration, serial L → (S ∥ C1 ∥ C2 ∥ X) → I.
- **Verification:** fresh verifier on the blessed swarm branch, briefed with all 22 criteria
  and told it is the last pass; swarm unit verdicts are inputs, never substitutes.
- **Landing:** `auto-land`.

### Author-time checklist

1. *Cross-artifact consistency:* the script-prose pairs are (a) commands ↔ `docs/CLI.md`,
   (b) error registry ↔ `docs/TROUBLESHOOTING.md`, (c) config schema ↔ `docs/CONFIG.md`,
   (d) quickstart ↔ README. **All four are mechanically enforced** by the integration unit's
   bidirectional test (criterion 15 enforcement half + 17) — pairs (b) and (c) drift hardest,
   since L adds codes and a config group in one worktree while X writes the docs in another.
   Externally observable behavior: exit codes 0/1/2/3/4 plus doctor's 5/6 (criterion 2), the
   envelope on success and failure incl. usage errors (3), and each command's branches —
   `init` fresh vs rerun (4); `onboard` dry-run / resume / scope-mismatch / unresolvable-dir /
   zero-transcripts / project-cap (5); `search` hit / empty / file-cap (6); `doctor` ok / warn
   / error / absent-store (8); `status` and `stats` populated vs empty (9, 10); `purge`
   preview / token-per-form / wrong-token / export-fail / commit-fail / ambiguous-slug (11).
   Every branch maps to a criterion; every criterion maps to a subtask
   (L→1,12,13,14,19,20,21,18a; S→6,7; C1→2,3,4,8,9,10; C2→5,11,20; X→15,16,18b,22;
   I→15-enforcement,17). No orphans either direction.
2. *State-machine completeness:* **Onboard:** none →(start) in-progress →(complete, deletes
   state file) done [terminal] | →(interrupt) resumable →(`--resume`, same scope) in-progress
   | →(`--resume`, different scope) rejected [terminal, exit 1]; dry-run makes no transition.
   **Purge:** requested →(preview) awaiting-confirm →(token | `--yes`) executing →(commit)
   done [terminal] | →(wrong token) aborted [terminal, 4] | →(export fails) aborted
   [terminal, 3] | →(commit fails) **deleted-uncommitted** [terminal, 3, remedy printed].
   **Doctor finding:** ok | warn | error, each terminal, aggregated to 0/5/6. The FTS index
   machine is deleted with the index. All non-terminal states have entry and exit paths.
3. *Loop-bound rule:* onboard caps at `--sessions` (30), `--max-bytes` (500 KB) and
   `--projects` (50 — the project scan spawns git per uncached directory and is user-sized);
   the search scan caps at 2000 files, newest first, with a `warnings` entry over it;
   `--limit` defaults 10, caps 100; purge has no loop; doctor runs a fixed check list; the
   release workflow has no retry; verify fix loop ≤2 (skill); amendment rounds ≤2 (skill,
   1 used). No unbounded loop.
4. *Why shouldn't we do this?* It adds a second consumer of every library contract, where
   drift is born — mitigated by A17 (no logic in `src/cli/`), criterion 21 (the boundary is
   lint-enforced), and criterion 19 (hooks limited to two named files, checked mechanically).
   Second: it is the first run whose output a human reads directly, so a bad exit-code or
   envelope decision is expensive once anyone scripts against it — mitigated by freezing both
   before any unit starts. Third: dropping FTS reduces a spec-fixed component; the user
   decided it at the gate and the judgment entry records what would prove it wrong.
5. *What goes wrong when we do this?* (a) The scan gets slow on a large store — bounded by
   the file cap, surfaced in `warnings`, and the judgment entry names the threshold at which
   FTS returns. (b) Wiring `secrets.patterns` lets a malformed user regex break redaction —
   parse-and-skip with a logged error, never a throw, hardcoded patterns always in force.
   (c) Docs drift from the binary — the bidirectional test fails the build. (d)
   `purge --session` under-delivers against a privacy expectation — stated in three places;
   dropping it would lose the one scope that works. (e) The inert publish job rots untested —
   accepted and named: asserted gated, not asserted working.
6. *Artifact enumeration:* greps run at intake and re-verified by the contract reviewer —
   `grep -rlnE "src/cli|src/search|node:sqlite|index\.db|CLI_JSON" …` → 1 hit (the spec);
   `git ls-files | grep -vE '^(docs|src|test|assets|skills)/'` → 18 files, each owned;
   `grep -rn matchPages src test` → `user-prompt-submit.ts:15,53`, `match.ts:10,73`,
   `match.test.ts` ×9 (the hook consumer criterion 19 protects); `grep -rn "redact(" src` →
   6 call sites, all inheriting A21's threaded signature; `grep -rn
   "buildInjection|INJECTION_BUDGET_TOKENS" src` → `injection.ts`, `tokens.ts`,
   `capture.ts:107`; `grep -rn "pendingWarnings|recordWarning" src` → `session-start.ts:59`,
   `capture.ts:280`, `errors.ts:127,198,221,266`; **`grep -rn "logError" src` → 17 call sites
   across 10 files** (added after the contract reviewer flagged its omission — this is
   criterion 14's real blast radius and the reason the CLI-mode signal is a module flag);
   `grep -rn STOP_CAPTURE_THRESHOLD src` → `capture.ts:27`, `stop.ts:15,50`;
   `grep -rn "gitignore|config.json" src/core/store.ts` → no hits; `grep -rn "\[\[" 
   src/core/decay.ts` → `decay.ts:55,59`; `ls .github` → absent. No unaccounted hits.

## Open decisions

None.

---

Run file: `.deliver/runs/2026-07-30-mehmory-cli.md` (read this first — it holds the ledger)
Branch: create `feat/cli`
Envelope: 13 dispatches
Resuming: this is a deliver-idea run at step 4; approval was granted 2026-07-31T02:37:27Z.

---

## Design review

Four dispatches, all pre-gate, all intake-charged. One amendment round (1 of 2), applied as
exactly the reviewers' proposed fixes; verdicts carry forward bound to plan+amendments.

**Spec stage — chaos-engineer adversary vs. the spec's run-3 surface.** FAIL: 4 BLOCKER /
13 MAJOR / 8 MINOR / 5 PASS. Blockers: the FTS rebuild job has no claimant and the spec names
two mutually exclusive rebuild triggers; a tagged marketplace release would ship a plugin
whose five hook bundles are gitignored, with no package/binary names pinned; two of the four
documented escape hatches (`injection.budget_tokens`, `secrets.*`) are declared and never
read; `purge --session` is unimplementable after integrate and purge's git-history semantics
are undefined. Majors incl.: KPI table never synced while `doctor` is told to enforce it;
error registry cannot express the CLI's failures and three landed `actionable` fixes are
prose; Node-version check is the wrong instrument for fts5 (probed directly: fts5 is a build
property); onboard's transcript-dir→key mapping undefined post-UC3; two onboarding surfaces
unreconciled; swapping the hook to FTS would silently change its corpus; half of `stats` has
no source field; the store has no `.gitignore` so `doctor`'s git check is meaningless;
`doctor` must parse SCHEMA.md against A4; `init`'s plugin verification has no contract; the
TTHW gate can only assert the CLI half; project keys are multi-segment with no discovery
rule; **FTS5 is over-scoped for the corpus the product defines**. Five PASSes with evidence,
incl. a direct probe that A9/A11 do not obstruct a CLI (both rules gate on `src/core/`).

**Plan stage — contract reviewer.** FAIL: 1 BLOCKER / 12 MAJOR / 9 MINOR / 8 PASS. Blocker:
"file sets are disjoint" was false — three of four parallel units must edit C1's dispatch
table (→ registry convention, C1 lands stubs). Majors: X's two tests cannot pass in a
parallel worktree since they spawn `dist/cli.mjs` (→ integration unit owns them); criterion
19 split across L and X on one file (→ ownership split); criterion 14 forces hook edits no
unit owned (→ L owns the two named ones); only one of four script-prose pairs was
mechanically enforced (→ test extended to error codes and config keys); A17/A18 enforcement
was prose with no criterion (→ criterion 21); doctor's exit on a missing store contradicted
criterion 2 (→ never exits 2); the degraded path cannot cover `log.md`; purge's
commit-failure state missing; index schema-version state missing; onboard resume scope
undefined and state file never deleted; cold index build and onboard's project scan
unbounded; **gap 5 changes fixed KPI numbers without a gate-raise mark** (→ marked);
`logError`'s 17 call sites never enumerated (→ added, CLI-mode flag). Enumeration spot-check
re-ran five greps, all reproduced.

**Plan stage — architecture reviewer.** FAIL: 2 BLOCKER / 8 MAJOR / 4 MINOR. Blockers: A18
contradicted A3 unacknowledged — `node:sqlite` performs file I/O outside `fs.ts` and the lint
rule matches only `fs`/`node:fs`, so nothing would catch it; and the FTS pivot criterion was
forward-referenced four times and never written. Majors: a fully-defaulted `config.json`
reasserts A4's shadow-defaults failure (→ empty `{}`); A20's `FORMAT_VERSION` coupling
contradicts `spec:193` and would fire a warning with no user action (→ compare against the
template constant); config-aware `redact`/`buildInjection` is ambient-vs-threaded, a decision
left unstated (→ A21); A18's sqlite restriction unenforced; `scopes.ts` ignores A5's alias
map; tag-only bundles are a provenance decision recorded only as a criterion;
`CLI_JSON_SCHEMA` in `format.ts` contradicts A17. Also established that "no second
implementation" was unachievable, and that A12's enforcement claim is aspirational for three
of its four rules. Check 4 (deletion survival) PASS.

**Plan stage — UX reviewer.** FAIL: 2 BLOCKER / 12 MAJOR / 4 MINOR. Blockers: the empty-store
hook nudge fires after a successful `onboard` and names the rival surface, because
`storeIsUnpopulated()` checks `project.md`/`pages/` not the inbox (→ onboard writes a stub
`project.md`; docs cannot reconcile a hook that contradicts state the CLI just wrote); the
purge confirmation token is undefined for `--all` and ambiguous for a substring-matched
project, inverting friction against blast radius (→ token pinned per form). Majors: the
quickstart order cannot deliver its own magical moment; Node <22.5 would silently degrade
instead of prompting an upgrade; usage errors exit before learning `--json` was requested;
`errors[]` element shape unspecified; four commands take scope flags four different ways; no
`--global` purge scope; three landed actionable fixes are prose; "indexed by literal error
text" unusable because `what` is runtime-variable; zero-transcript onboard undefined;
`doctor` omits the config-disabled-hook check run 2 assigned it; permission-denial fork
missing from the README; bare page slug does not name a scope; TTHW caveat unassigned in what
the user reads.

---

## Execution ledger

landed: 2026-07-31T14:48:48Z (PR #3 squash-merged as `a3307e7`; measurement window approved
2026-07-31T02:37:27Z → landed 2026-07-31T14:48:48Z)

**Dispatches: 13 of 13** (envelope fully spent) (intake-charged separately: 4 of 4 — spec adversary, contract,
architecture, UX reviewers). Execution: L (opus), X (sonnet), C1 (opus), S (sonnet),
C2 (opus), I (opus) workers; V-L forward-looking verifier (sonnet); V-F final verifier
(opus, told it was last); 2 fix resumes (L on the whitelist leak, X on the release
workflow). **Both fix attempts spent, 2 dispatches held for landing.** 0 experiments.
Branch `feat/cli`, 12 commits.

Observed model verified from dispatch transcripts for every dispatch
(`jq -r 'select(.type=="assistant") | .message.model'` over
`~/.claude/projects/-home-cgetsfred-Developer-mehmory/db0f33c7-*/subagents/agent-*.jsonl`) —
requested matched observed throughout; no silent override, no blank observed-model column.

### Defect-catch tally (born-at → caught-at)

| Stage caught | Count | Notes |
|---|---|---|
| Spec stage (adversary) | 25 | 4 BLOCKER / 13 MAJOR / 8 MINOR — all born in the spec, all triaged into amendments before planning |
| Plan stage (3 reviewers) | 54 | contract 1B/12M/9m, architecture 2B/8M/4m, UX 2B/12M/4m — one amendment round, applied as exactly the reviewers' proposed fixes |
| Impl (worker-noticed, `Plan defects noticed:`) | 21 | L:4, X:3, C1:6, S:1, C2:4, I:3 — incl. 5 further dead config keys, `logError` throwing out of core, and criterion 17 being unimplementable as written |
| Lead triage (cross-unit seams, pre-merge) | 5 | `E_USAGE` undocumented by construction; plugin-name match; `doctor`-after-`init` exits 5; `status` scope flags; the predicted S↔C2 conflict — all visible only by reading two reports against each other |
| Verify (V-L, mid-run) | 1 BLOCKER | `secrets.whitelist` under-redaction: a whitelist fragment overlapping a secret leaked the whole secret to the inbox. Born in L, reported by L **as safe** |
| Verify (V-F, final) | 1 | criterion 18 unmet (class `code`) — the required test absent, and `secrets` used in a job-level `if:` where GitHub does not provide it, which killed the whole workflow |
| Landing | 4 | 1 CI failure (3 tests, **born run 1/2** — hardcoded developer path; never executed before because this run built the first CI) + 3 Copilot findings, all fixed pre-merge |
| Post-ship | 0 | as of landing |

Born-at vs caught-at: the two verification boundaries caught 2 defects between them, both
born in implementation and **both already reported green by their own units**. V-L's
forward-looking half (the tail units' preconditions) found nothing — the preconditions held,
which is a real result and the reason the fan-out cost no rework.

### Recommendations (Q / Rec / Chosen)

1. Run-3 scope / all-in with publish inert / same — aligned.
2. TTHW gate / automated proxy only / same — aligned.
3. FTS5 in run 3 / **drop it, ship the scan** / same — aligned. (Recommendation reversed my
   own frozen plan after three reviewers converged against it.)
4. License / MIT / same — aligned.
5. Purge confirmation grammar / keep the two-step, amend / same — aligned.
6. `purge --session` reach / keep store-wide / same — aligned. **6/6 this run.**

### Judgments ledger

- **Drop FTS5** — see the Judgments section below; pivot criteria recorded there.
- **Fan out before re-verifying L's whitelist fix.** Alternatives: spend a dispatch
  re-verifying first (no envelope room), or merge unverified (violates the gate). Basis:
  data — the four tail units consume none of `redact()`'s internals, so a still-broken
  filter could not invalidate their work. Expected: fix holds, 70% confidence; pivot signal:
  V-F's repro fails. **Actual: positive** — V-F re-ran both repros and the inverse, all pass.
- **Drop the batched round-2 verifier (V-2).** Alternatives: verify four unmerged partial
  trees (weaker and largely duplicated by the final pass). Basis: debate. Expected: no loss
  of coverage, envelope moves from zero slack to two spare. **Actual: positive** — the two
  non-duplicated duties moved into V-F's brief and both were executed there.
- **Split round 2 into two waves.** Basis: data — C1 and S/C2 would have created the same
  `src/cli/commands/*.ts` paths with no common ancestor, an add/add conflict three times
  over. Expected: same dispatch count, one extra wave. **Actual: positive** — merges came
  back clean except the single predicted `cli-framework.test.ts` conflict.

### Escalations

1. **License undeclared** (unit L invented `MIT` to satisfy criterion 18) — resolved: MIT,
   LICENSE file added by X, recorded in the world model.
2. **Purge confirmation grammar** — criteria 11 and 2 are mutually unsatisfiable; resolved
   by the user in favor of the two-step, recorded as spec amendment 30.
3. **`purge --session` reach** — resolved: store-wide, spec amendment 31.
4. **Auto-land trust gate** — the diff adds `.github/workflows/` with a tag trigger,
   `contents: write`, and an npm publish job. Widened workflow permissions and triggers are
   a named trust decision under auto-land's step-2 checklist. Resolved: user approved landing
   both workflows and a full auto-land.
5. **Commit signing failed** (1Password agent, `failed to fill whole buffer`) on the CI-fix
   commit. Per the standing rule the fix was left staged rather than committed unsigned;
   user unlocked, commit retried and signed (`G`).

No envelope breach; every dispatch counted before spend. The envelope finished **exactly
spent at 13 of 13** — the last dispatch went to the CI root-cause fix, and everything after
it (review fixes, merge, ledger) was orchestrator work requiring no agent.

### Landing-stage findings

- **CI red on first run.** Three run-1/run-2 tests hardcoded the absolute developer checkout
  path; on a runner that directory does not exist, so `execFileSync`'s `cwd` pointed nowhere
  and Node reported it as `spawnSync node ENOENT` — an error naming the command, not the
  directory. The other two failures were the same path interpolated into generated worker
  scripts. **Baseline failures by the verify stage's own rule** (present before the run,
  recorded not charged) — this run built the CI that first executed them. Fixed with
  `process.cwd()` + `process.execPath`, proven by reproducing all three failures locally
  against a rewritten path and by a stripped-`PATH` control.
  **The orchestrator's stated hypothesis (the hermetic guard dropping `PATH`) was wrong**;
  the worker disproved it with evidence rather than implementing it. Had it not, the fix
  would have gone green for the wrong reason and left the `cwd` bug latent.
- **Copilot: 3 findings.** Two doc claims corrected (`lastIntegrate` returns a timestamp,
  not the log line; `E_APPEND_FAILED` carries a different consequence when raised through
  `failOpen`). The third — `stats --all` aggregating records for undiscoverable projects —
  was **half rejected with reasoning**: the unfiltered aggregate is deliberate and pinned by
  a test using an `unlisted/project` fixture, so a purged project keeps its history.
  Filtering by discovered keys broke that test, which is how the intent surfaced. The real
  defect the reviewer had found — one report spanning two populations — was fixed by
  labelling the directory-derived lines `(projects on disk)` under `--all`.
- **Security review: clean.** No finding survived falsification. It attacked the
  `secrets.whitelist` offset arithmetic specifically (strict containment holds; a named-group
  edge case fails *closed* toward redaction), confirmed purge cannot escape the store root,
  that every git call is `execFileSync` with an argv array, and that `ci.yml` uses
  `pull_request` rather than `pull_request_target`. Two hardening notes recorded, neither
  exploitable: an unvalidated page slug reaching `join()` from a trusted terminal invocation,
  and the named-group offset assumption.

### Delivered-vs-approved diff

Done-when evidence: V-F PASS on all 22 criteria at `6e744f0`, cited per criterion, with an
explicit split between criteria re-run against the fix commit and criteria carried forward on
a proven-empty diff (`git diff --stat 29d5afe feat/cli -- src/ docs/ …` → empty).

**Delivered differently than approved** (both user-approved at the gate, both landed as spec
amendments 30 and 31):
- **Purge confirmation is two invocations, not an interactive prompt.** Criterion 11 assumed
  a prompt; criterion 2 forbids a command body writing to stdout, so one invocation cannot
  preview and then block. Strictly more friction, on an irreversible command.
- **`purge --session <id>` reaches every inbox in the store**, not only the selected scope.

**Approved but not delivered:** nothing.

**Delivered beyond the subtask file lists, all traceable:**
- `src/core/environment.ts`, `src/core/doctor.ts`, `src/core/status.ts`,
  `src/core/stats-report.ts`, `src/core/onboard.ts`, `src/core/purge.ts`,
  `src/core/search.ts`, `src/core/scopes.ts` — library placements forced by A17 (the CLI is a
  thin consumer); trace to criteria 4–12.
- `src/core/errors.ts` fail-open hardening — `logError` was throwing out of core (A2/A11
  violation), so an unwritable store turned every `failOpen` into a throw, hooks included.
  Found by C1 while building criterion 2's exit-3 path; traces to criteria 14 and 20.
- `src/distill/distill.ts` redact threading — the debt item L found and C2 closed; traces to
  criterion 13.
- `LICENSE` — criterion 18 requires the `license` field; the file behind it was a documented
  standing-convention gap, escalated and answered.
- `test/docs-consistency.test.ts`, `test/quickstart.test.ts`, `test/release-workflow.test.ts`
  — criteria 15, 17, 18.
- Mandated state: this run file. No untraceable change (V-F scope-compliance: 73/75 files
  map directly, 2 traceable by rule).

**Known gaps, named not hidden:** the release workflow is asserted *gated*, never *executed*
— criterion 18 asks for the former and the plan's own risk register says so; five further
dead config keys (`lock.*`, `queue.*`, `warning.rate_limit_ms`, partial `log.rotation_size_mb`)
documented as unhonored rather than wired; `E_CURSOR_RESET` registered with no construction
site; the quickstart's 5-minute budget has ~460 ms of actual against it and cannot fail on
regression; git identity is assumed by the store's commit path.

### Pointers

- Swarm archive: `.swarm/archive/SWARM_STATE-2026-07-31-cli.md`; unit reports under
  `.swarm/reports/{unit-l,unit-x,unit-c1,unit-s,unit-c2,unit-i,v-l,v-final}/`.
- For run 4: wire or delete the five dead config keys and `E_CURSOR_RESET`; add `actionlint`
  to CI (it would have caught criterion 18's defect mechanically); export a frozen
  `ERROR_CODES` array so the docs test stops regexing `errors.ts`; tighten the quickstart
  wall-time budget to something that can fail; **criterion 18's own text specifies a shape
  GitHub does not support** — do not re-read it literally.

---

## Judgments

- **judgment:** Drop FTS5 from run 3 and ship `search` on one multi-corpus scan.
  **alternatives:** (a) build the index as the spec fixes it — rejected: the fallback had to
  exist regardless and `matchPages` cannot reach `log.md`, making the index a second
  implementation, and it required a named A3 exception the lint rule cannot enforce, an index
  schema version, a cold-build bound and a corruption path; (b) FTS required with no
  fallback — rejected: costs the command entirely to users on an fts5-less build, for a
  corpus of a few dozen small files.
  **basis:** debate (spec adversary M13 + architecture check 3 + contract M7 converging
  independently), decided by the user at the gate.
  **expected:** the scan answers every real query under the search budget for the life of
  v1; 75% confidence.
  **pivot criteria:** the scan exceeds ~1 s on a real store, or a store's scanned corpus
  passes the 2000-file cap often enough that `warnings` fires routinely. Either signal
  reopens FTS as a run-4 item — with the index built behind the same scan interface, so
  nothing else changes.
  **Priors considered:** run-1 amendment 11 measured FTS5 availability "as evidence for
  run 3"; accepted as accurate and dismissed as a reason — availability is not need.
