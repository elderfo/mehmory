# Copilot instructions for mehmory

`AGENTS.md` at the repo root is the primary guide — directory map, subtask ownership,
architecture summary, error-code registry, and testing strategy. Read it first. This file adds
Copilot-specific conventions and a maintenance matrix that AGENTS.md doesn't spell out.

## Stack

TypeScript strict mode (`tsconfig.json`: `strict: true`), ESM only, Node >=22, pnpm workspace,
tsup for bundling, vitest for tests, ESLint flat config with custom rules in `eslint-rules/`.

## Code style

- **No `any` in `src/`.** Enforced by a custom ESLint rule (`eslint-rules/index.js`), not just
  convention — CI fails on it.
- **`src/cli/` is import-isolated from the library.** A custom rule
  (`eslint-rules/index.js` → `no-cli-imports`) blocks non-CLI code from importing
  `src/cli/**`. CLI argument parsing, exit codes, and the `--json` envelope stay CLI-only;
  business logic never depends on them.
- **Core stays synchronous, never exits, imports `fs` only in `fs.ts` and `errors.ts`**
  (ADRs A9, A11, A3 in `docs/WORLD_MODEL.md`). Don't add `process.exit()` or async I/O to
  `src/core/*` outside those two files without checking the ADR first.
- Format with Prettier (`.prettierrc`); don't hand-format around it.

## Framework and runtime patterns

- **Host branching lives in one place.** `src/transcript/host.ts`
  (`readSession(path, host)`) and `src/core/host.ts` are the only places that branch on which
  harness (Claude Code vs Codex CLI) invoked a hook. New harness-specific logic goes through
  that seam — don't add ad hoc `if (host === 'codex')` checks elsewhere.
- **Hook bundles are committed, not gitignored.** `src/hooks/*.ts` compiles to `hooks/*.mjs` via
  tsup; the Claude Code plugin marketplace installs from this repo's default branch, so the
  built bundle has to be present and current in git (ADR A25). CI's
  "Check committed hook bundles are up to date" step fails the build if `hooks/` differs from a
  fresh `pnpm build`. **Never hand-edit a file under `hooks/*.mjs`** — edit the corresponding
  `src/hooks/*.ts` source and rebuild.
- **Session state mutations go through the lock helpers.** `Stop`, `SessionEnd`, and
  `UserPromptSubmit` hooks can all touch the same per-session state
  (`src/core/session.ts`, `src/core/capture.ts`) concurrently. Any new code path that reads or
  writes session state, the finalization marker, or the transcript cursor must go through
  `withSessionLock` / `withProjectLock` (`src/core/lock.ts`) — see "Conventions mined from PR
  reviews" below for why this matters in practice.

## Conventions mined from PR reviews

Recurring, reviewer-caught patterns from past PRs (#49, #50, #52) — check for these before
touching session lifecycle or capture code:

- **Composite identifiers need unambiguous encoding, not string concatenation.**
  `sessionEndLogTag("alpha#1", 0)` and `sessionEndLogTag("alpha", 1)` producing the same tag
  was a real bug: two different sessions collapsed onto one dedupe key. When a value is built
  from more than one logical field (session id + generation, project key + scope, etc.), encode
  it so the fields can't bleed into each other, and add a regression test with two inputs that
  would collide under naive concatenation.
- **Don't call a locked operation from inside another locked operation on the same lock.**
  The project/session locks in `src/core/lock.ts` are not reentrant. A finalization path that
  calls a helper which itself acquires the same lock will time out and silently fall back to
  stale state — this has shipped as a real bug (`finalizeSessionUnlocked` → `distillDelta` →
  `updateSessionState` → `withSessionLock` again). When adding a call inside an already-locked
  function, check whether the callee acquires a lock itself.
- **A lock-timeout fallback must not proceed as if it succeeded.** If `withProjectLock` (or
  similar) gives up after its retry budget, the caller must not run the guarded operation
  unlocked — that silently reopens the same race the lock exists to prevent.
- **Recheck invariants after acquiring a lock, not just before.** A pre-lock check
  (e.g. `isSessionFinalized(sessionId)`) can go stale while waiting for the lock if another
  process finalizes in between. Re-verify the condition once the lock is held.
- **Cleanup on the error path still has to leave state consistent.** If a step like removing a
  finalization marker fails, the function must not report success and move on as if the marker
  were gone — a partially-applied cleanup should either retry, surface the failure, or roll back
  the state it already changed.

## Test conventions

- Every test runs against a temp `MEHMORY_HOME` — the guard is in `test/setup.ts`. Don't read or
  write `~/.mehmory` directly in a test.
- Worked examples from `docs/superpowers/specs/2026-07-28-mehmory-design.md` are test vectors —
  when the spec gives a concrete input/output pair, there should be an assertion for it.
- **Retrieval changes are graded by the golden set, not by feel.**
  `test/fixtures/golden-queries.json` + `test/retrieval-golden.test.ts` report Recall@1 and
  Recall@3, including a paraphrase split (queries sharing no vocabulary with their target page).
  Run this before and after any change to weighting, tokenizing, stopwords, or scoring in
  `src/core/search.ts` / `src/distill/patterns.ts`, and record the new numbers in the fixture's
  measurement block.
- **The two always-on token budgets are tested, not just documented**: the `SessionStart`
  injection frame (`injection.budget_tokens`, asserted in `test/injection.test.ts`) and the six
  skill `description` fields (~650 tokens total, capped at 800 combined / 160 each, asserted in
  `test/plugin-skills-layout.test.ts`). Don't raise either ceiling without a commit that says
  why.
- `test/docs-consistency.test.ts` checks the CLI docs and the actual binary agree in both
  directions — a new or changed CLI command needs both the code and `docs/CLI.md` updated in
  the same change, or this test fails.

## Maintenance matrix

What else needs to change when you touch these files:

| You changed                                                                                            | Also update                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks/*.ts`                                                                                       | Run `pnpm build` and commit the resulting `hooks/*.mjs` (and any new/removed `hooks/chunk-*.mjs`) — CI's bundle-drift check fails otherwise.                            |
| New `E_<CODE>` in `src/core/errors.ts` `ERROR_KINDS`                                                   | `docs/TROUBLESHOOTING.md` (indexed by error code + the stable part of the message).                                                                                     |
| New/changed config key in `src/core/config.ts`                                                         | `docs/CONFIG.md` (every group, real default, and whether it's wired up or currently inert).                                                                             |
| New/changed CLI command in `src/cli/commands/*.ts` or `src/cli/index.ts` registry                      | `docs/CLI.md`; `test/docs-consistency.test.ts` checks both directions.                                                                                                  |
| Codex- or Claude-Code-only behavior in `src/core/host.ts`, `src/transcript/host.ts`, or a hook adapter | `test/hooks-host.test.ts` and/or `test/hooks-codex.test.ts`.                                                                                                            |
| New skill under `skills/`                                                                              | `plugin.json` and `.claude-plugin/plugin.json` manifest entries; keep the `description` field within the shared 800-token budget (`test/plugin-skills-layout.test.ts`). |
| Version bump                                                                                           | `VERSION` is canonical; `package.json`, `plugin.json`, `.claude-plugin/plugin.json` must mirror it (tests enforce the match) — plus `CHANGELOG.md`.                     |
| Scoring/weighting/tokenizing in `src/core/search.ts` or `src/distill/patterns.ts`                      | `test/fixtures/golden-queries.json` measurement block (new Recall@1/Recall@3 numbers) via `test/retrieval-golden.test.ts`.                                              |
| `injection.budget_tokens` or skill descriptions                                                        | `test/injection.test.ts` / `test/plugin-skills-layout.test.ts`.                                                                                                         |
| Any behavior, command, config key, or error code                                                       | The affected file under `docs/` in the same commit — see `CONTRIBUTING.md`.                                                                                             |

## Commits and PRs

Conventional commits (`<type>(<scope>): <subject>`; types: `feat`, `fix`, `docs`, `chore`,
`refactor`, `test`). One logical unit of work per PR, branched off `main`. No AI/bot
attribution in commit messages, trailers, or PR bodies. Run `pnpm lint && pnpm test &&
pnpm typecheck && pnpm build` before pushing — the pre-commit hook already runs lint and test.
