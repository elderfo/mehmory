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
