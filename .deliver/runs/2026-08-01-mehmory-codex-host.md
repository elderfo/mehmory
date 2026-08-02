# Run — mehmory Codex host (issue #14)

date: 2026-08-01
slug: mehmory-codex-host
source: GitHub issue elderfo/mehmory#14 (spec, approved) + tickets #16–#26
approved: 2026-08-01
landed:
Dispatches: 0 / 26

## Resume header

Everything needed to execute this run without the originating conversation:

- Spec: `gh issue view 14` — problem, 49 stories, 14 locked implementation decisions, testing decisions.
- Tickets: `gh issue view <16..26>` — each carries What-to-build + acceptance criteria + Blocked by.
- Repo conventions: `AGENTS.md`; ADRs `docs/WORLD_MODEL.md` A1–A22 (never `docs/adr/`).
- Measured Codex facts: `.research/codex-spike/VERDICT.md` (gitignored, absolute path
  `/home/cgetsfred/Developer/mehmory/.research/codex-spike/VERDICT.md`), payload captures in
  `.research/codex-spike/payloads/*.json`, prototype `.research/codex-spike/spike.mjs`.
- Real Codex rollouts for fixtures: `~/.codex/sessions/**/*.jsonl` (161 present).
- Codex CLI installed locally: 0.146.0. `[features] hooks = true` already set in `~/.codex/config.toml`.

## Approved plan (rev 1)

### Problem

mehmory captures and injects only in Claude Code. A developer working in both harnesses
has one project but two half-memories, and neither harness can see which is out of date.
Issue #14 is spec'd, decided and broken into eleven `ready-for-agent` tickets; none of the
implementation is written.

### Done-when

1. Tickets #16–#26 are each implemented to their own acceptance criteria, verifiable
   ticket-by-ticket against the criteria text in the issue.
2. `pnpm lint && pnpm test && pnpm typecheck` pass on the integration branch head.
3. A Codex `SessionStart` payload fed to the built `hooks/session-start.mjs` injects the
   routing block for the resolved project; the same project key as Claude Code resolves in
   the same repo.
4. A Codex `UserPromptSubmit` payload captures to the inbox, with the entry recording
   `codex` as the learning harness; a pre-format-change entry still parses and attributes
   to Claude Code.
5. `mehmory init --host codex` against a temp `CODEX_HOME` merges mehmory's entries,
   preserves a pre-existing foreign entry, is idempotent on re-run, writes backups, and
   enables the hooks feature flag; uninstall removes only mehmory's entries.
6. `mehmory doctor` reports the four Codex checks, each mapped to a registered `E_` code.
7. ~~The Codex `PreCompact` payload shape is measured against Codex CLI 0.146.0 and pinned by
   a fixture — not assumed.~~ **Superseded in rev 2 — see below.**
8. Codex rollout fixtures captured from real rollouts sit in the transcript fixture set as
   input/expected-output pairs asserted by exact equality; the fixture contract test routes
   through the reader for both harnesses.
9. No test touches the real store or the real `~/.codex` — the hermetic guard in
   `test/setup.ts` covers `CODEX_HOME` as well as `MEHMORY_HOME`.
10. README, site, both plugin manifests, and `docs/{CLI,CONFIG,TROUBLESHOOTING,PRIVACY,UPGRADE}.md`
    describe two-harness support; the docs-consistency suite covers the Codex surface in
    both directions.
11. ADRs A23 (host is threaded and declared, never detected) and A24 (the transcript reader
    is the normalization boundary) are recorded in `docs/WORLD_MODEL.md`.
12. Version sources read `0.2.0` and a single PR lands the whole surface on `main`.

### Scope

In: tickets #16–#26 as written. The two ADR clarifications. Version bump to 0.2.0.

Out (spec's own out-of-scope, restated so the verifier can hold the line): any third
harness; per-harness stores or sync; team memory; an MCP surface; Codex tool-call events;
making the Stop nudge work under `codex exec`; rewriting store git history; migrating
existing untagged inbox entries.

In (settled at the approval gate): cutting and pushing the `v0.2.0` git tag, and the
`release.yml` run it fires.

### Stages

- Plan approval (core gate) — fixed, unconditional.
- Verify stage (core gate) — fixed, unconditional.
- Design review — **skipped by user instruction** ("no need for plan reviews at this
  time"). Predicate would otherwise have fired: #14's spec is a contract (hook I/O,
  inbox line format, CLI envelope).
- Architecture mini-loop — `skipped:` the structural decisions are already made and
  locked in #14's Implementation Decisions and in ADRs A12/A21; this run implements a
  settled design rather than choosing one.
- UX mini-loop — `skipped:` the user-facing surfaces (CLI flags, skill behavior, injected
  block) are specified verbatim in the tickets; no interface is being designed here.
- Experiment/spike — **fires once**: #24's `PreCompact` payload shape is unmeasured.
  Extends `.research/codex-spike/spike.mjs` rather than rewriting it. 1 of the 2 allowed.

### Subtasks

Dependency-ordered into five waves. Each unit owns one ticket, branches off the shared
integration branch, and merges back into it.

| Wave | Units | Tickets |
|---|---|---|
| 1 | 5, parallel | #16 finalization prefactor · #17 inbox helper via CLI · #18 declare host · #19 Codex rollout reader · #20 host on inbox entries |
| 2 | 1 | #21 install + doctor (needs #18) |
| 3 | 3, parallel | #22 recall in Codex (18,21) · #23 capture in Codex (19,21) · #25 skills to Codex (17,21) |
| 4 | 1 | #24 finalize without session-end (16,23) — carries the PreCompact spike |
| 5 | 1 | #26 docs, positioning, 0.2.0 (all) |

### Dispatch shape

`swarm`, with this orchestrator declaring that it owns landing — swarm stops at its
blessing and returns `swarm_branch` unlanded.

Branching: one integration branch `feat/codex-host` off `main`. Unit branches cut off it
and merge back into it — no per-unit PR, because `main`'s ruleset protects `main` only and
eleven Copilot reviews of one feature's slices costs more than it catches. One PR
`feat/codex-host` → `main` at the end, Copilot-reviewed, squash-merged with explicit
`--subject`/`--body`.

Worktrees per parallel unit; each runs `pnpm install` (Husky hooks, `node_modules`) before
working, per the standing convention.

Model tier, declared not inherited: `opus` for #19, #21, #23, #24 (fixture-normative
parsing, config merging, hook I/O against a measured contract). `sonnet` for #16, #17, #18,
#20, #22, #25, #26.

### Envelope

- `dispatch_budget`: 26 (11 units + swarm lead overhead + 1 PreCompact spike + 1 verifier
  + 2 fix attempts + slack).
- Every unit must leave `pnpm lint && pnpm test && pnpm typecheck` green before reporting.
- No unit touches `~/.mehmory` or `~/.codex` outside a temp home.

### Spec gaps

None blocking. Two facts the spec itself flags as unverified are ticketed rather than
assumed: the `PreCompact` payload shape (#24, spiked in this run) and whether a Codex
plugin can self-register hooks (#25, confirm-only — the install does not depend on it).

### Open decisions

Empty. (Open *questions* below are scope boundaries the user answers at the approval gate,
not unresolved design.)

### Gate decisions

1. **Release tag — in scope.** User chose the full path over the recommendation to stop at
   the merge: version bump, PR merged, `v0.2.0` cut and pushed, `release.yml` fires.
   Recorded as a user decision, not an orchestrator default.
2. **`.research/codex-spike/` stays gitignored.** Workers read it by absolute path in the
   primary checkout; nothing needs it in history.

## Approved plan (rev 2) — amendment to done-when 7

approved: 2026-08-01, at the user's decision on escalation E1.

**Why.** Two spike attempts could not make Codex 0.146.0 fire `PreCompact`. The first ran the
fenced capture and returned `not observable`: the event exists in the binary and has fired on
this machine before (a `hook.state` entry in `~/.codex/config.toml` proves it), but a
`codex exec` run fires `SessionStart`, `UserPromptSubmit` and `Stop` and never compacts. Both
config files were restored byte-identical, verified. The second attempt — force the event by
lowering the compaction threshold under the same fence — was **denied by the auto-mode
classifier** with only one other worker active, so it was a content objection, not the
concurrency ceiling. The lead neither routed around the denial nor absorbed the unit.

Presented to the user with four options (collapse to the ticket's own fallback / user runs the
measurement / grant the permission and retry / defer #24 entirely). **User chose: collapse.**

**Done-when 7, as amended:**

> Codex finalization runs at the **next session start** for anything left pending — the safety
> net issue #24 names in its own text. A `PreCompact` hook is still registered, but built
> defensively: it validates the payload it actually receives, fails open on an unknown shape
> (A2, A8), and **no fixture pins an unmeasured payload**. The inability to measure
> `PreCompact` on Codex CLI 0.146.0 is documented as a known limitation alongside the
> `codex exec` Stop-nudge limitation, rather than worked around.

**What this costs:** the compaction-time finalization latency win. Correctness is unaffected —
the next-session-start path was always the safety net, and #24's acceptance criteria already
require it independently ("anything left pending is applied at the next session start", "a
session that ends abruptly loses no captured material once the next session starts").

Every other done-when criterion and the scope section are unchanged from rev 1.

## Ledger

### Verification and defect-catch tally

Three boundaries, all pass. Where each defect was caught:

| Stage | Caught | What |
|---|---|---|
| Worker self-check | 4 | P5's unconditional trailing newline (hidden by a fixture that happened to end in one) and its bundle-path resolution; P6's placeholder `cwd` and its redaction test that asserted against a line the distiller never captures |
| Cross-report read (lead) | 1 | the host-type triplication, visible only by putting P1's, P3's and P4's reports side by side |
| V1 (wave 1) | 2 | the host-type triplication confirmed and typed as `string`; `finalizeSession`'s double-write on a partial marker-write failure |
| V2 (waves 2–3) | 1 | the per-harness toggle was tested against capture but never against injection — V2 wrote its own probe |
| V3 (final) | 3 | #24's stale GitHub criterion; the Claude-Code-only CLI tagline; `"hooks": {}` uninstall residue |
| Worker falsifying the brief | 3 | F1: both my suggested fixes for the double-write were wrong; P8: `finalizeSession` at PreCompact retires a live session; P8: the D9 fix is in a different file and 9× the estimate |

**Lead-brief defects (mine), 5:** the P3 brief omitted the missing-uuid problem and the
`response_item` double-write; `_conduct.md` said `pnpm install` where the seams need
`pnpm install && pnpm build`; I quoted a 578-test baseline as 576 in two briefs *as a
stop-condition trigger*; I named `finalizeSession` as PreCompact's operation in P8's acceptance
criteria; I relayed P6's D9 measurement across a boundary it was never valid outside.

The pattern in the last two: **a measurement one unit made inside its own boundary does not
transfer to another unit's, and relaying it as the lead lends it authority it never earned.**
Both were caught by workers who traced the claim instead of building on it — which is what the
conduct block's falsification rule is for.

### Dispatches

18 of 26 approved. 16 charged (2 classifier denials did no work and are not charged).

| Kind | Count |
|---|---|
| Implementation units | 9 (P1–P9, with #16+#18 and #22+#23 batched) |
| Fix / merge units | 3 (F1 seams, M1 `hook.ts` conflict, F2 tagline) |
| Verification | 3 (V1, V2, V3) |
| Investigation | 1 charged (SPIKE); SPIKE-2 denied |

Retries: **0**. No unit needed a second attempt.

Concurrency ceiling observed at **3**, not the planned 4 — P2's first two dispatches were denied
with three workers active and launched cleanly the moment a slot freed.

### Judgments

| Decision | Expected | Actual |
|---|---|---|
| Merge wave 1 *before* verifying it, so the verifier saw the assembled branch | the defect most likely this wave lives between units, invisible per-unit; medium confidence | correct — V1's two findings were both cross-unit |
| Batch #16+#18 and #22+#23 rather than one unit per ticket | removes overlapping hunks in the same hook file, saves 2 dispatches | correct — no conflict in either pair |
| Take the D9 Stop-`{}` fix rather than leaving it | removes an unknown on the most frequent path; inert on Claude Code | correct, but my *sizing* was wrong — see the tally |
| Spend the last experiment on forcing compaction | ~40% it fires | never ran; dispatch denied |
| Escalate #24 rather than defaulting the scope narrower | the amendment is the user's call, not mine | user chose collapse |
| Fix the CLI tagline before tagging | one line; the binary's self-description contradicted the release | correct, nothing pinned it |

### Branches, PRs, escalations

- Integration branch `feat/codex-host`, 10 unit branches merged locally and deleted; none pushed.
- Escalations: **1** (E1 — `PreCompact` unmeasurable and the retry dispatch denied). Resolved by
  the user as plan rev 2.
- Issue #24 carries a comment recording the amendment, since its acceptance criteria were never
  edited to match.

### Delivered vs approved

Every done-when criterion met, criterion 7 as amended by rev 2. All eleven tickets #16–#26
delivered. V3 confirmed no out-of-scope item appeared: no third harness, no per-harness store or
sync, no team memory, no MCP surface, no `PreToolUse`/`PostToolUse` registration, no `codex exec`
workaround, no history rewrite, no inbox migration.

**Two deliberate departures, both recorded rather than silent:**

1. **One plugin manifest, not two.** #25 and #26 both say "both manifests". P7 measured that
   Codex CLI 0.146.0 reads `.claude-plugin/plugin.json` and `marketplace.json` directly and
   declined to fabricate a duplicate, because a second copy creates exactly the two-surface drift
   #26 exists to prevent. Satisfies the criteria by intent, departs from their letter.
2. **Per-harness stats (spec #14 story 39) was delivered outside the approved scope.** The plan's
   scope reads "tickets #16–#26 as written"; story 39 was never ticketed, and I instructed P9 to
   implement it without returning to the approval gate. It traces to the user's actual
   request — "the remainder of the work for issue 14" — so the delivered work matches what was
   asked; the plan I wrote was narrower than the request. `+71` lines with tests, additive,
   flagged by V3 "for the record, not a defect", and surfaced to the user before landing. The
   gap was in my planning, not in the work.

Stories 37 and 38 were verified to hold for free — neither purge nor status has a harness axis
to filter on.

### Carried forward (not this run)

`.swarm/SWARM_STATE.md` holds the full debt ledger with owners and triggers. Open past this run:

- **The highest-consequence unknown: Codex's hook-trust mechanism.** `config.toml` carries
  `[hooks.state.*] trusted_hash`; a freshly written mehmory entry has no hash, and whether Codex
  prompts or refuses on first run is unverified on 0.146.0 and untestable without touching a real
  user configuration. If Codex refuses untrusted hooks, `init --host codex` installs cleanly and
  captures nothing. **The user's one-command check: run `mehmory init --host codex`, start a
  Codex session, and see whether the routing block appears.**
- `PreCompact`'s payload remains unmeasured; finalization relies on the next-session-start path.
- `InboxEntry.host` stays optional on the interface (`src/core/inbox-tx.ts` and `seedStore` are
  the blockers), though `host` is a required argument through the capture chain.
- `PENDING_FINALIZE_IDLE_MS` (30 min) is a judgement call, not a measurement.
- Cosmetic: uninstall reformats, and can leave `"hooks": {}` in, a foreign-shaped config file.
