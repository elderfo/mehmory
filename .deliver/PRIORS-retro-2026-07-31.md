# Retro — 2026-07-31

Scope: two unretroed runs — `2026-07-29-mehmory-runtime` (run 2) and
`2026-07-30-mehmory-cli` (run 3). Fired on demand. Together they completed the three-run
delivery of the approved mehmory spec.

Cycle 2 of 3 for recommendation-alignment convergence (cycle 1 was the 2026-07-29 retro).

---

## 1. Numbers

### Defect-catch by stage

| Run | Spec | Plan | Impl | Lead triage | Verify | Landing | Post-ship | Experiments |
|---|---|---|---|---|---|---|---|---|
| mehmory-runtime | 20 | 20 | 15 | 1 | 4 (2 BLOCKER) | 4 | 0 | 0 |
| mehmory-cli | 25 | 54 | 21 | 5 | 2 (1 BLOCKER) | 4 | 0 | 0 |

Born-at, read alongside: every spec-stage finding was born in the spec; every plan-stage
finding born in the plan; impl findings are workers catching **upstream** defects (plan and
spec text), not their own errors. The verify column is small and that is the point — those
6 findings were all born in implementation and **all had already been reported green by the
unit that wrote them**.

Landing in run 3 breaks down as 3 Copilot findings + 1 CI failure. The CI failure is a
**baseline** failure by the verify stage's own rule: three run-1/run-2 tests hardcoded an
absolute developer path and had never executed in CI, because run 3 built the first CI. It
blocked the merge and was fixed, but it is not a run-3 defect.

### Tally cross-check duty

Performed against the raw report fields, not the summary. Both runs: every worker returned
both `Plan defects noticed:` and `Own mistakes made:` with an explicit `none` where empty —
8 workers in run 2, 7 in run 3 (verifiers return verdicts, not these fields, and are
correctly excluded). **No discrepancy.** This is the direct payoff of the 2026-07-29 retro's
P4: that retro could not perform this check at all because the fields did not exist.

### Recommendation-alignment rate

| Cycle | Run(s) | Aligned |
|---|---|---|
| 1 | mehmory-foundation | 3/4 = 75% |
| 2 | runtime 4/4, cli 6/6 | **10/10 = 100%** |

Convergence is still undefined — it needs three consecutive cycles within ±5 points, and
cycle 1 to cycle 2 moved 25 points. Recording as cycle 2 of 3.

Caveat worth stating plainly: a 100% rate is not self-evidently good. It can mean the
recommendations were sound, or that the questions were posed so the recommendation was the
only reasonable answer. Run 3's question 3 (drop FTS5) is the one that carries real
information — the recommendation **reversed the orchestrator's own frozen plan** on three
reviewers' evidence, so alignment there measures the user agreeing with a correction, not
with an author defending their draft.

### Envelope actuals

| Run | Dispatch budget | Actual | Fix attempts | Intake-charged |
|---|---|---|---|---|
| runtime | 11 | 9 | 0 of 2 | 4 of 4 |
| cli | 13 | **13 — exactly spent** | 2 of 2 | 4 of 4 |

Run 3 finished with zero slack, and got there by dropping a planned verification stage at a
round boundary (see Keep). Two reserves were consumed by things the plan did budget for:
one CI-fix dispatch and one security review. Nothing breached; every dispatch was counted
before spend.

### Context actuals (measured — `scripts/session-cost.ts`)

| Run | Requests | Baseline | Peak | Growth | Output | Subagents | Subagent output |
|---|---|---|---|---|---|---|---|
| runtime (`953569ee`, → landed) | 323 | 53,770 | 391,083 | 337,313 | 481,707 | 14 | 375,511 |
| cli (`db0f33c7`, approved→landed) | 207 | 254,696 | 494,443 | 239,747 | 271,892 | 10 | 507,543 |

Run 3's baseline is high because intake, the four design reviews and the approval gate all
preceded the measurement window in the same session — the window opens mid-session by
construction. Whole-session figures for run 3: 290 requests, peak 511,523, output 497,193,
14 subagents, 599,600 subagent output.

**Subagent share: 65% of run 3's output tokens** (507,543 of 779,435 in-window total),
against 44% in run 2. The direction is right — the lead is delegating more of the work it
should never do itself — and it is well clear of run 1's 72%, which was inflated by 13
agents whose reports never came back.

---

## 2. Keep / Start / Stop

### Keep

- **A verification boundary between a foundation unit and its fan-out.** (data) It caught a
  BLOCKER in both runs, and in both cases *after* the unit reported green: run 2's V1 found
  `.gitignore` swallowing `src/hooks/`; run 3's V-L found `secrets.whitelist` leaking whole
  AWS keys. Neither was reachable by any per-unit gate, because in both cases the unit's own
  tests passed.
- **Giving that verifier a forward-looking second job.** (data) Probing the *next* units'
  preconditions belongs to no unit, so nothing else can fail on it. In run 3 it cleared the
  CLI build entry, the `bin` target, and gate-poisoning from sibling worktrees before four
  units built on them — and the fan-out then cost zero rework.
- **Telling the final verifier that nothing follows it.** (data) Both runs' honest FAILs came
  from a verifier told it was last. Run 3's also volunteered where its evidence was thin,
  unprompted, and split re-run criteria from carried-forward ones when asked.
- **Briefing workers to falsify the lead's stated hypothesis.** (data) Twice in run 3 the
  orchestrator was wrong — FTS5's justification, and the CI `PATH` hypothesis — and both
  times the corrective came from an agent explicitly told the claim was a guess to disprove.
  The CI worker's fix would otherwise have gone green for the wrong reason and left the real
  `cwd` bug latent.
- **Reading unit reports against each other before consolidating.** (data) Run 3's five seam
  findings were invisible to every per-unit verifier by construction — the halves lived on
  different branches. Run 2 found the same class once (the Stop-reason ↔ `inbox-tx` contract
  mismatch).
- **Writing briefs to files rather than into dispatch prompts.** (data) Every brief this run
  went to `.swarm/handoff/`; the lead's in-window output was 272k against 508k delegated.

### Start

- **Verify that a criterion's named mechanism exists before freezing the plan.** (data) Run 3
  froze two criteria that specified impossible mechanisms: criterion 18 required a single
  `if:` naming both a tag ref and `secrets.NPM_TOKEN`, which GitHub's context rules forbid at
  job level, and criterion 11's interactive prompt contradicted criterion 2's "a command body
  never writes to stdout". Both survived four review dispatches. Neither is a *coherence*
  failure — they are internally consistent and externally impossible, which is exactly the
  class the three rule classes cannot catch.
- **When a plan adds CI to a repo that has none, budget for baseline failures.** (data) Run 3
  discovered at landing that three older tests had never run outside one developer's
  filesystem. The first CI run is the first execution of every test in the repo, and the
  envelope had one dispatch left for it.
- **State the ancestor when parallel units create files under a new shared directory.** (data)
  Run 3's original decomposition had three units creating the same `src/cli/commands/*.ts`
  paths from a branch point where the directory did not exist — an add/add conflict three
  times over. Caught by the lead before dispatch, but only by chance of re-reading the
  ownership table; nothing in the plan template prompts for it.

### Stop

- **Letting a worker's characterization of a security control's failure direction stand
  without a probe.** (data) Unit L reported `secrets.whitelist` as over-redacting — safe
  direction, documented in a `ponytail:` comment. It was under-redacting: a six-character
  whitelist fragment passed a whole AWS key to the inbox. The report actively steered a
  reader away from the defect. A direction-of-failure claim about a security control is a
  measurement, not an observation.
- **Planning a verification stage per round without asking what it can actually verify.**
  (debate) Run 3's V-2 was budgeted to verify four *unmerged* branches — four partial trees,
  none of which is the thing that has to be correct. Dropping it for one final pass on the
  assembled package lost no coverage and returned two dispatches of slack.

---

## 3. Promotions — individually gated

**P1 — dispatch-templates conduct block: direction-of-failure claims need a probe.**
Scope: `~/.claude/skills/swarm/assets/dispatch-templates.md`, conduct block.
Rationale: the run-3 whitelist leak. The block already says a falsifying measurement halts
the change; it does not say that a claim about *how* a control fails must carry a command
and its output. Proposed line: "A claim about the direction in which a security control
fails — over-blocking vs under-blocking, fail-open vs fail-closed — is a measurement, not an
observation: probe the adversarial case (a fragment, an overlap, a boundary) and quote the
output, or do not make the claim."

**P2 — intake author-time checklist: mechanism check.**
Scope: `~/.claude/skills/deliver-idea/references/intake-grilling.md`, author-time checklist.
Rationale: criteria 18 and 11 above. Proposed seventh item: "Mechanism check — for every
criterion naming a specific platform mechanism (a CI context, a hook capability, an API
field, a syscall), confirm the mechanism exists and supports the use named, citing the
documentation. A criterion can be internally consistent and externally impossible; the three
rule classes only test the first."

**P3 — plan template: name the branch ancestor for parallel units.**
Scope: `~/.claude/skills/deliver-idea/references/intake-grilling.md`, decomposition section.
Rationale: the add/add conflict above. Proposed: when two or more parallel units create files
under a directory that does not exist at the branch point, they conflict on every shared
path; either sequence one unit to land the directory first, or assign each unit a distinct
path with no shared parent.

**P4 — envelope must show its arithmetic.**
Scope: same reference, Envelope section.
Rationale: run 3's plan wrote `dispatch_budget: 14` over a list of components summing to 13;
the contract reviewer caught it. Proposed: the envelope states the sum explicitly
(`5 workers + 1 integration + 1 verifier + 2 fix + 2 landing = 11`), so a mismatch is visible
rather than arithmetic a reader has to perform.

**P5 — mehmory run 4: the five dead config keys and the dead error code.**
Scope: this repo. `lock.retry_count`, `lock.retry_delay_ms`, `lock.stale_ms`,
`queue.max_claims`, `queue.stale_ms`, `warning.rate_limit_ms` are shadowed by hardcoded
constants or have no read site; `log.rotation_size_mb` is honored for `stats.jsonl` but not
`errors.log`; `E_CURSOR_RESET` has no construction site. All documented as unhonored rather
than wired — honest, but the same class as run 3's BLOCKER 3. Wire or delete.

**P6 — mehmory run 4: add `actionlint` to CI.**
Scope: this repo, `.github/workflows/ci.yml`.
Rationale: it would have caught criterion 18's defect mechanically, before a human reasoned
it out from GitHub's context tables. The release workflow remains asserted-gated and
never-executed; a schema check is the cheapest instrument available for it.

**P7 — mehmory run 4: export a frozen `ERROR_CODES` array.**
Scope: this repo, `src/core/errors.ts`.
Rationale: `test/docs-consistency.test.ts` regexes `ERROR_KINDS` out of the source because
the object is deliberately unexported. It asserts the literal was found before using it, so
it fails loudly rather than silently — but a frozen exported array is the obvious upgrade.

---

## 4. Judgment read-through

**6 ledgered judgments in this batch** — 2 in run 2, 4 in run 3. Say "read the judgments"
for a read-through.

---

## Notes for run 4

- Both gate-raised contract changes from run 3 are binding: FTS5 is out of v1 (deferred
  behind a named threshold — scan latency >~1 s or the 2000-file cap firing routinely), and
  the recall/contradiction KPIs are unowned in v1.
- Spec amendments 30 and 31 record the delivered-vs-approved differences: purge confirmation
  is two invocations, `purge --session` reaches every inbox in the store.
- The release workflow has never executed. The first `v*` tag is `build-tag`'s first run.
- `fs.test.ts` and `queue.test.ts` spawn with `{...process.env}` rather than the hermetic
  helper. Hermetic in practice, but they bypass the guard the rest of the suite routes
  through.
- Two hardening notes from the clean security review, neither exploitable: an unvalidated
  page slug reaching `join()` from a trusted terminal invocation, and a named-capture-group
  offset assumption in `redact.ts` that fails closed.
