# Retro — 2026-07-29

Scope: one unretroed run, `2026-07-29-mehmory-foundation` (`retroed: false`). Fired on
demand, not by the 3-run threshold.

The run delivered run 1 of 3 of the approved mehmory spec: the foundation library. It landed
as PR #1 after a same-day recovery effort and a seven-unit swarm that closed 15 findings.

---

## 1. Numbers

### Defect-catch by stage

**Tally cross-check duty — discrepancy, escalated.** The run file has no `Defect-catch:`,
`Judgments:`, `Plan defects noticed:` or `Own mistakes made:` lines. Only `Envelope: 12
dispatches` at line 464. The mechanical count the retro is supposed to validate against does
not exist, so the table below is reconstructed from commit messages, the findings ledger and
verifier verdicts — which is exactly the reconstruction the skill warns against for context
figures, and should be treated as weaker evidence than a real tally would be.

Either the orchestrator never wrote those fields, or the run-file format in use predates
them. Worth settling before run 2, because a retro that cannot count is a retro that cannot
learn.

| Stage | Caught | Notes |
|---|---|---|
| Spec/plan | 16 | Run-1 amendments to the spec, agreed at intake |
| Impl | — | not separately recorded |
| Verify | **5 critical** | GPG commit hang, path traversal via crafted remote, cwd-vs-toplevel key fragmentation, redaction applied only on read, cursor offset with no consumer — all born-at impl, all caught **after** the run file already recorded the work as verified |
| Verify (2nd round) | 15 | The recovered subagent findings: 14 fixed, 1 falsified |
| Landing | **2** | Non-compiling branch (`tsc` failure); deferred-commit coverage gap |
| Post-ship | 0 | PR open, Copilot review pending |

**Born-at vs caught-at matters here.** Reading caught-at alone says "verify is earning its
keep." Reading born-at says something worse: the five critical defects were born in impl and
survived a break/restore discipline that had already been recorded as passing. The discipline
only ever probed properties someone had named — nothing in it mentioned commit signing, so
nothing in it could have found the GPG hang.

### Context actuals (measured — `scripts/session-cost.ts`)

| Session | Requests | Baseline | Peak | Growth | Output | Subagents | Subagent output |
|---|---|---|---|---|---|---|---|
| `855328e6` plan + impl | 62 | 71,142 | 159,385 | 88,243 | 131,986 | 4 | 45,057 |
| `6c82944f` review + silent agents | 638 | 37,618 | 456,811 | 419,193 | 557,638 | 18 | 391,223 |
| `31dfafce` recovery + swarm + land | 296 | 54,017 | 369,161 | 315,144 | 325,657 | 14 | 299,989 |
| **Total** | **996** | — | — | — | **1,015,281** | **36** | **736,269** |

Wall clock 2026-07-29T05:04Z to 18:38Z — 13h34m. All `claude-opus-5`.

**72% of all output tokens went to subagents** (736,269 of 1,015,281). The middle session
alone burned 557,638 output tokens across 18 subagents, and 13 of those never reported — that
session is where the naming defect lived.

### Envelope actuals

| | Planned | Actual |
|---|---|---|
| Run-1 dispatches (run file) | 12 | 22 subagents across two sessions |
| Swarm dispatches | 16 | 17 (raised once, user-approved) |
| Swarm retries | 4 | 5 (raised to 6, user-approved) |
| Swarm verifications | 4 | 5 (raised, user-approved) |

Every raise was requested before spending, and granted. No cap was silently exceeded.

Three of the five swarm retries went to one unit's *infrastructure* churn, not its work — and
two of those three were caused by a wrong lead instruction. The unit's actual code landed on
its first attempt. The 2–3 attempt cap does not distinguish these, and should.

### Recommendation-alignment rate

Four decisions were escalated with an explicit recommendation:

| Question | Recommended | Chosen | Aligned |
|---|---|---|---|
| `claimJob` job typing | add `jobType` parameter | same | yes |
| Result shape | standardize on `{ ok }` now | same | yes |
| Swarm scope | (4 options offered) | all of it | yes |
| `_jobType` vs `{ type, data }` envelope | lead leaned envelope | keep `_jobType` | **no** |

**Rate: 3/4 = 75%.** One cycle only — convergence is undefined until three consecutive
retros. Recording as cycle 1 of 3.

The single miss is instructive: the verifier recommended keeping `_jobType` on the grounds of
a "cheap upgrade path," the lead argued that reasoning ran backwards (zero callers makes it
cheap *now*, expensive later), and the user chose the verifier's answer. The lead's reasoning
about cost timing was not wrong, but it over-weighted a change that was additive either way.

---

## 2. Keep / Start / Stop

### Keep

- **Briefing findings as `unverified` with explicit permission to falsify.** (data) Two units
  came back with "the defect described is not there." One of them was right and prevented a
  bad fix. Finding 9 was falsified outright.
- **Adversarial verification told it is last.** (data) The only two FAIL verdicts in the
  entire effort came from the two verifiers explicitly told nothing followed them. Every
  verifier that believed another pass was coming returned a pass.
- **Tracing false claims before they reach a brief.** (data) Five of the recovered findings
  were wrong. The lead traced them, marked them false in the work orders, and no worker
  spent a dispatch "fixing" a defect that did not exist.
- **Break/restore as an acceptance bar for tests.** (data) Three hollow tests were replaced
  and each replacement demonstrated failing against a deliberately broken implementation.
  The final verifier re-ran all three independently and they held.
- **Harvesting worker reports before worktree cleanup.** (data) One worker wrote its report
  outside its worktree; a blind cleanup would have destroyed the only copy of the reasoning
  behind a merged contract change.

### Start

- **Write the `Defect-catch:` / `Judgments:` / `Plan defects noticed:` / `Own mistakes made:`
  fields during the run, not at retro time.** (data) This retro could not perform its own
  cross-check duty because the fields are absent.
- **Run `tsc` in the pre-commit hook.** (data) `.husky/pre-commit` runs `pnpm lint && pnpm
  test`; vitest transpiles without type-checking and ESLint's `strictTypeChecked` rules are
  disabled. A non-compiling branch passed every gate and was only caught by a verifier running
  the compiler directly. Every unit in the effort reported its gate "green" against this.
- **Distinguish infrastructure retries from work retries in the attempt cap.** (data) 3 of 5
  retries were effort infrastructure; charging them against a unit's 2–3 cap misreads a
  working unit as a struggling one.
- **When first-hand evidence contradicts a verifier, hold the evidence until the
  contradiction is explained.** (debate) The lead had a correct IDE diagnostic naming the exact
  failing line, recorded it, briefed the verifier to check it first, and then deferred when the
  verifier reported clean *with citations*. The citation format made a wrong answer more
  credible, not less.

### Stop

- **Passing `name` to the Agent tool for report-shaped work.** (data) It creates an
  `in_process_teammate` at `spawnDepth: 0` whose output goes to its own transcript and never
  returns to the caller. 13 agents did real work and reported nothing; ~2 hours went to
  chasing them, and 391k subagent output tokens were spent in that session. Resume-by-id was
  subsequently proven to work on *unnamed* subagents, which removes the only stated reason to
  name them up front.
- **Letting a worker run in the main checkout because it is "a single mutating unit running
  alone."** (data) The isolation rule protects the git index; it does not protect against a
  worker doing destructive file operations. One such worker truncated `.gitignore` from 13
  lines to 1 and deleted 65 lines from the spec doc. Uncommitted and recovered, but only
  because `HEAD` was clean.
- **Recording a run as verified on a break/restore pass alone.** (data) The run file recorded
  run 1 verified; a later review found five critical defects in that same code.

---

## 3. Promotions — individually gated

Each requires approval before implementation. Not bundled.

**P1 — `swarm` delegation reference: name the naming trap.**
Scope: `~/.claude/skills/swarm/references/delegation.md`, Claude Code provider adapter.
Rationale: the doc's "Resume Before Respawn" section says to capture worker ids at dispatch
and treats resume as the default follow-up, and the Codex adapter mandates `task_name`. A
lead reading provider-neutral prose reasonably reaches for `name`. The correct rule exists but
is one clause in an adapter section. Proposed addition: `name` converts a one-shot into a
persistent teammate whose report goes to its own transcript, not the caller;
`run_in_background: false` does not override it; resume a completed unnamed worker by the
**id** returned at dispatch.

**P2 — `swarm` worktree isolation: ignore rules are part of the setup.**
Scope: `~/.claude/skills/swarm/references/worktree-isolation.md`.
Rationale: the skill places worktrees under `.swarm/` and tells every worker to write to
`.scratch/`, relying on `.swarm/` being gitignored. ESLint 9 flat config does not read
`.gitignore`, so the parent repo lints every worktree. This cost three corrective dispatches
and blocked an unrelated commit with 58 errors from three units' scratch directories.
Proposed: the administrative-prep pass adds ignore entries to the repo's lint/typecheck
config, not only `.gitignore`.

**P3 — Agent tool description: `name` suppresses the inline return.**
Scope: harness tool description (upstream, not user-editable).
Rationale: it documents `name` as making an agent addressable via `SendMessage` — purely
additive. It does not say naming removes the return value, which is the part that bites.
Filed as an observation; no local action available.

**P4 — Run-file format: make the retro fields mandatory at run close.**
Scope: `~/.claude/skills/deliver-idea/references/run-file-format.md`.
Rationale: see the cross-check discrepancy above. A retro that must reconstruct its own
inputs from commit messages produces weaker conclusions than one reading a tally.

**P5 — mehmory: add `tsc --noEmit` to `.husky/pre-commit`.**
Scope: `.husky/pre-commit` in this repo.
Rationale: closes the gap that shipped a non-compiling branch past four gates. Small change,
and run 2 is when it starts costing real time.

**P6 — `AGENTS.md` pointer to gitignored working directories.**
Scope: `AGENTS.md` in this repo.
Rationale: `.work/case-study/`, `.research/` and `.swarm/reports/` hold the process lessons
and the evidence behind every decision, and none of it is in git. A fresh session reads
`AGENTS.md` to orient and has no reason to look in a gitignored directory — so nothing warns
run 2 against repeating the naming mistake.

---

## 4. Judgment read-through

The run file carries no `Judgments:` entries, so there is nothing to read through. This is the
same absence as the cross-check discrepancy above, not a separate finding.

---

## Notes for run 2

- Contracts run 2 inherits are committed prose, not just code: `{ ok }` union,
  `claimJob(jobType?)`, and the `_jobType` reservation at `docs/WORLD_MODEL.md` item 12.
- The hooks table in the spec fixes latency budgets (`UserPromptSubmit` <100ms, `Stop` <5s,
  `PreCompact` <15s). Run 1 never measured against them; the hot-path work done today was
  aimed at them but is still unmeasured end-to-end because no hook exists to measure.
- Finding 9 is recorded as **falsified**, not fixed. `src/core/redact.ts` is byte-identical to
  where run 1 started.
