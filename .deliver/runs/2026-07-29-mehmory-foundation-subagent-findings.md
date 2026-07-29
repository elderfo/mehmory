# Run 1 — recovered subagent findings

Nine review agents (`spec-{api,maint,perf,security,testing}`, `simp-{altitude,efficiency,reuse,simplify}`)
produced findings that never reached the main thread; their reports were mined from the
subagent transcripts after the fact. Each finding below was re-checked against the code at
`29baf39` before being classified.

## Resolution status

All 15 open findings were closed by a seven-unit parallel effort on this branch: **14 fixed,
1 falsified.** Suite went 199 to 208 tests; lint, `tsc --noEmit`, and `build` all clean.

| Findings | Outcome |
|---|---|
| 1, 8 | `claimJob(jobType?)` added, `claimed/` listed once per call |
| 2, 3, 13a | Result shapes standardized on `{ ok }`; `lockPath` documented; `E_APPEND_FAILED` collapsed |
| 4, 5 | `resolveProjectKey` cached per cwd; `buildInjection` counts each string once |
| 6, 7 | `warnings.json` parse cached behind a content hash; log size tracked instead of stat-per-append |
| **9** | **FALSIFIED — see below** |
| 10, 11, 12 | Three hollow tests replaced, each demonstrated failing against a broken implementation |
| 13b, 14, 15 | `E_CONFIG_PARSE` collapsed; `ponytail:` labels corrected; shared temp-dir helper with teardown |

**Finding 9 was wrong, and the attempted fix was the actual vulnerability.** The claimed ReDoS
in the private-key pattern was not reproducible — measured at 0.07ms on the pathological input.
The hardening that replaced `[\s\S]*?` with a tempered token could not cross a false `-----END`
inside a key body, so a private key containing that literal string would have been written to
disk unredacted, and ran 322x slower on the input it was meant to protect. Reverted;
`src/core/redact.ts` is byte-identical to `29baf39`. The unit's net contribution is the
regression test for the false-terminator case, which nothing had covered.

Two things closed that were not on this list: the leaked `/tmp/mehmory-test-*` directories
(~3159 / 210MB from run 1 — new orphans now zero, existing ones left for the user to remove),
and the queue's `_jobType` contract, now recorded in `docs/WORLD_MODEL.md` because run 2 builds
against it.

**One process defect found along the way, not fixed here:** `.husky/pre-commit` runs
`pnpm lint && pnpm test` but never `tsc`. Vitest transpiles without type-checking and ESLint's
`strictTypeChecked` rules are disabled, so this project can fail to compile while every
pre-commit check passes. A type error shipped through that gap during this effort and was
caught only by a verifier running the compiler directly. Worth closing before run 2.

## Already closed before mining

| Finding | Closed by |
|---|---|
| spec-perf / spec-api — `readTranscript` reads the whole file, ignoring the cursor offset | `29baf39` (`readFileFrom`) |
| spec-maint — `SCHEMA_TEMPLATE` byte-drifted from `assets/SCHEMA.md` | `29baf39` (drift test) |
| spec-security — `normalizeRemoteUrl` path traversal via crafted remote | `a08142b` |
| spec-security — `redact` applied only at read time | `a08142b` |
| spec-security / spec-perf — `realpath(1)` subprocess and non-canonical fallback | earlier run-1 work (`realpath` in `fs.ts`) |
| spec-testing — no subdirectory test for a no-remote repo | `a08142b` (`test/identity.test.ts:205`) |

## Rejected on inspection

| Finding | Why rejected |
|---|---|
| spec-perf — `resolveProjectKey` calls `loadConfig()` twice per invocation | The two calls (`identity.ts:63`, `identity.ts:83`) are in mutually exclusive branches. One load per invocation. |
| spec-testing — rate-limit test at `test/errors.test.ts:280` is racy, never waits the window | The test rewinds `lastTime` by 61 minutes and re-invokes. It does not depend on wall-clock waiting. |
| spec-testing — `test/injection.test.ts:189` asserts a calculated sum | The expected value is the literal `75`, not a re-derivation of the inputs. Weak assertion, not a tautology. |
| simp-reuse / spec-maint — unify the six `JSON.parse` sites behind one helper | Both agents independently concluded the validator is the costly part and is domain-specific per site. Agrees with the call already made. |
| simp-altitude — `appendRecord` lock injection and dual-site `redact` are at the wrong altitude | Judged correct as built: `lock.ts` imports `fs.ts`, so injection is the minimal inversion, and redaction belongs at each write boundary, not one choke point. |

## Open — contract questions run 2 inherits

Settle these before run 2 starts; they change call sites.

1. **`claimJob()` has no job type** (`src/core/queue.ts:56`, spec-api HIGH). Claims the first
   available job. Run 2 has three hook producers (SessionStart / UserPromptSubmit / SessionEnd)
   racing one queue, so a SessionEnd worker can claim a UserPromptSubmit job. Decide: add a
   `jobType` parameter, prefix directories (`queue/{sessionend,...}/`), or document
   first-queued-wins and require producers to be interchangeable.
2. **Three incompatible result shapes** (spec-api HIGH). `appendRecord` returns
   `{ success, error? }` (`fs.ts:186`), `commitPaths` returns `{ committed, deferred? }`
   (`git.ts:24`), `initStore` returns `{ ok, ... } | { ok: false, error }` (`store.ts:17`).
   ADR A11 mandates typed results but does not fix the field name. Run 2 authors must memorise
   three conventions. Standardising on the `ok` discriminated union is the widest of the three.
3. **`appendRecord`'s `lockPath` parameter is undocumented** (`fs.ts:186`, spec-api HIGH).
   The parameter exists to break the `fs` ↔ `lock` circular import; nothing in the signature or
   docstring tells a caller to pass `withProjectLock`. Doc-only fix.

## Open — performance, all on run 2's hot path

The `<100ms` UserPromptSubmit budget is spec'd; none of these were measured against it in run 1.

4. **`resolveProjectKey` spawns 2 git subprocesses per call** (`identity.ts:97,118`, spec-perf
   CRITICAL). ~10–30ms each. The key is deterministic per working directory, so a module-level
   cache keyed by cwd is safe for a hook's lifetime.
5. **`buildInjection` re-counts tokens in the truncation loop** (`injection.ts:77`, spec-perf
   HIGH). `estimateTokens` runs 3 times up front and up to ~100 more inside the loop on the same
   strings. Have `truncateToTokens` return the count alongside the text.
6. **`recordWarning` reads, parses and rewrites `warnings.json` on every `logError`**
   (`errors.ts:172`, simp-efficiency). ~1ms and 3 filesystem operations per warning. Batch in
   memory, flush at SessionEnd.
7. **`logError` stats the log file after every append to check rotation** (`errors.ts:157`,
   simp-efficiency). Rotation only triggers above 5MB. Track the size in module state instead.
8. **`claimJob` lists `claimed/` once per queued job** (`queue.ts:83`, spec-perf MEDIUM).
   O(n) directory reads for n jobs. Read once before the loop into a Map keyed by job ID.

## Open — robustness

9. **Private-key redaction pattern can backtrack** (`redact.ts:43`, spec-perf HIGH). The pattern
   uses `[\s\S]*?` with `gi`. Input is transcript text, which is attacker-influenceable: a large
   `BEGIN`-without-`END` block is a plausible ReDoS. Needs a bounded terminator or a length cap,
   plus a test with a pathological input.

## Open — hollow tests

Both survive a broken implementation, which is the same failure class the run-1 break/restore
pass was meant to catch.

10. **`test/cursor.test.ts:77`** passes `newOffset=0` to `advanceCursor` and then asserts the
    offset is 0. The comment concedes it: "the caller detects truncation and passes newOffset=0".
    Nothing tests that truncation is detected. Either move detection into `advanceCursor` and drop
    the argument, or add a test that the caller-side detection exists.
11. **`test/tokens.test.ts:37`** asserts `TOKEN_ESTIMATION_TOLERANCE_PCT === 20` — it checks the
    constant is 20, not that estimation stays within 20%. Replace with a boundary test on a known
    input.

## Open — minor

12. **`test/config.test.ts:47`** never tests standalone that a missing `config.json` yields
    defaults without throwing (criterion 4). Existing assertions pass for any object carrying the
    default values.
13. **Two focused error helpers** (simp-simplify): `E_APPEND_FAILED` (`fs.ts` twice) and
    `E_CONFIG_PARSE` (`config.ts` twice), ~15 lines. `29baf39` declined a *generic* helper for all
    11 `MehmoryError` literals; this narrower proposal is a separate call. simp-simplify agrees
    `E_GIT_COMMIT` should stay spread across its three cases.
14. **`ponytail:` label misused** (spec-maint): `patterns.ts:77` and `patterns.ts:97` describe what
    a pattern matches rather than naming a ceiling and an upgrade path. `patterns.ts:57` names a
    ceiling but no upgrade. `errors.ts:13` documents an architectural constraint, not a shortcut.
15. **Test temp-directory setup repeated** in `config`, `identity` and `store` tests
    (simp-reuse). A `createTempDir(prefix)` helper saves ~3 lines per file — and would give the
    leaked `/tmp/mehmory-test-*` directories one place to be cleaned up.
