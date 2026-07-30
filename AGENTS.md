# mehmory — Project Guide

## Directory Structure

```
mehmory/
├── src/
│   ├── core/
│   │   ├── home.ts            # Store root path, env overrides (A)
│   │   ├── errors.ts          # Typed errors, logging, fail-open (A)
│   │   ├── fs.ts              # Atomic writes, append (C)
│   │   ├── lock.ts            # Project-level locking (C)
│   │   ├── git.ts             # Atomic commits (C)
│   │   ├── queue.ts           # Durable job queue (C)
│   │   ├── identity.ts        # Project key resolution (B)
│   │   ├── config.ts          # Config loader, defaults (B)
│   │   ├── cursor.ts          # Transcript cursor tracking (D)
│   │   ├── store.ts           # Store layout init (F)
│   │   ├── redact.ts          # Secret filter (E)
│   │   ├── tokens.ts          # Token estimation (E)
│   │   ├── injection.ts       # Context builder, cap enforcement (E)
│   │   ├── inbox.ts           # run 2 (in progress): inbox entry read/write, snapshot-clear (A)
│   │   ├── session.ts         # run 2 (in progress): per-session capture state, cursor scoping (A)
│   │   ├── decay.ts           # run 2 (in progress): recency decay/archive file ops (A)
│   │   ├── stats.ts           # run 2 (in progress): stats.jsonl writer (A)
│   │   └── match.ts           # run 2 (in progress): grep-based full-text matcher (A)
│   ├── hooks/                 # run 2 (in progress): thin hook adapters, bundled to hooks/*.mjs (B)
│   │   ├── session-start.ts
│   │   ├── user-prompt-submit.ts
│   │   ├── stop.ts
│   │   ├── pre-compact.ts
│   │   ├── session-end.ts
│   │   └── inbox-tx.ts        # bundled transactional helper for skills (C)
│   ├── schema/
│   │   └── format.ts          # Format constants, versioned template (A, F); run-2: inbox entry serialization (A)
│   ├── transcript/
│   │   └── reader.ts          # JSONL transcript reader, incremental parsing (D)
│   └── distill/
│       ├── patterns.ts        # Normative distill patterns (D, A7)
│       └── distill.ts         # Record → inbox entry distillation (D)
├── hooks/                     # run 2 (in progress): plugin hook dir — committed hooks.json plus
│                               # gitignored *.mjs bundles built from src/hooks/*.ts (B)
├── skills/                    # run 2 (in progress): plugin skills — integrate, lint, onboard-session,
│                               # remember, pause, resume (C)
├── .claude-plugin/            # run 2 (in progress): plugin.json manifest (C)
├── test/
│   ├── setup.ts               # Vitest setup, MEHMORY_HOME guard (A)
│   ├── home.test.ts           # home module tests
│   ├── errors.test.ts         # errors module tests with worked examples
│   └── format.test.ts         # format constants tests
├── eslint-rules/
│   └── index.js               # Custom ESLint rules (A3, A9, A11, U2)
├── package.json               # pnpm workspace, all devDeps (A)
├── tsconfig.json              # strict: true, no any (A)
├── tsup.config.ts             # ESM-only output (A10)
├── vitest.config.ts           # Test runner config (A)
├── eslint.config.js           # Flat config + custom rules (A); run-2: full strictTypeChecked, hooks/ ignored (D)
├── .prettierrc                 # Code formatting (A)
├── .husky/                     # Pre-commit hooks: lint, test, typecheck (A, D)
├── .gitignore                  # node_modules, dist, .deliver/SESSION.md, /hooks/*.mjs (D)
└── docs/
    └── WORLD_MODEL.md         # Architectural decisions A1–A11; run-2: A12–A16 (C)
```

## Working directories

Gitignored directories that hold run evidence and process lessons — not shipped, but a
fresh session should know they exist before assuming there's no history to check:

- `.work/` — in-progress worker scratch state for the current run
- `.research/` — investigation notes gathered while planning or debugging
- `.swarm/reports/` — per-unit swarm run reports (what each unit did, gate evidence, defects)

## Subtask Ownership

- **A** (this module): `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.husky/`, `.gitignore`, `AGENTS.md`, `docs/WORLD_MODEL.md`, `src/core/home.ts`, `src/core/errors.ts`, `src/schema/format.ts`, `test/setup.ts`, `eslint-rules/`, and all tests for A modules.

- **B**: `src/core/identity.ts`, `src/core/config.ts` — resolveProjectKey, loadConfig, MEHMORY_HOME, alias map.

- **C**: `src/core/fs.ts`, `src/core/lock.ts`, `src/core/git.ts`, `src/core/queue.ts` — atomic writes, locking, git, job queue.

- **D**: `src/transcript/reader.ts`, `src/distill/`, `src/core/cursor.ts` — JSONL reader, distill patterns, cursor.

- **E**: `src/core/redact.ts`, `src/core/tokens.ts`, `src/core/injection.ts` — secret filter, token estimation, context builder.

- **F**: `src/schema/format.ts` (shared with A), `src/core/store.ts`, `assets/SCHEMA.md` — store init, schema versioning.

### Run 2 (in progress) — hooks, skills, plugin packaging

Letters below are run-2 subtask units, distinct from the run-1 letters above (both runs
reuse A–F; check the run's plan doc for which is which).

- **D — debt + gates**: `eslint.config.js`, `.husky/`, `.gitignore`, `AGENTS.md` — full
  `strictTypeChecked`, `pnpm typecheck` in the pre-commit gate, `hooks/` ignored, test debt
  cleanup. Unlocks A.

- **A — library extensions**: inbox entry format + `src/core/inbox.ts`, `src/core/session.ts`
  (session-scoped cursor/counter/topic cache, removes global-cursor API), `src/core/decay.ts`,
  `src/core/stats.ts`, `src/core/match.ts`, new config keys, `package.json`/`tsup.config.ts`
  (hook bundle glob entry), `vitest.config.ts`, `test/setup.ts` subprocess-env guard. Unlocks
  B and C.

- **B — hooks**: `src/hooks/{session-start,user-prompt-submit,stop,pre-compact,session-end}.ts`,
  `hooks/hooks.json`, `test/hooks-*.test.ts`, `test/plugin-hooks-layout.test.ts`.

- **C — skills + packaging + amendments**: `skills/*/SKILL.md`, `.claude-plugin/plugin.json`,
  `src/hooks/inbox-tx.ts`, `test/inbox-tx.test.ts`, `test/plugin-skills-layout.test.ts`,
  `assets/SCHEMA.md` additions, spec `## Run-2 amendments`, `docs/WORLD_MODEL.md` A12–A16.

Unlock order: D → A → (B, C in parallel).

## Project Commands

- `pnpm install` — Install dependencies
- `pnpm build` — Build ESM output via tsup (→ dist/)
- `pnpm lint` — Run ESLint + Prettier check
- `pnpm test` — Run vitest
- `pnpm typecheck` — Run tsc strict mode
- `pnpm prepare` — Install Husky hooks (runs on `pnpm install`)

## Conventions

### Commit Messages

- Conventional commits: `<type>(<scope>): <subject>`
- Types: feat, fix, docs, chore, refactor, test
- No AI/bot attribution in messages, trailers, or PR bodies
- Sign all commits

### Pull Requests

- One logical unit of work per PR (per subtask boundary)
- Branches off `feat/runtime`, never directly to `main`
- Wait for Copilot review before merging
- Resolve PR comments one at a time with commits
- Never merge with failing CI or unresolved comments

### Code Quality

- `pnpm lint` + `pnpm test` before pushing (pre-commit hook runs these)
- Full test suite runs locally; CI verifies
- No `any` types in src/ (enforced by ESLint rule)
- TypeScript strict mode everywhere

### ADRs and Specs

- All architectural decisions are in `docs/WORLD_MODEL.md` § Architectural Decisions
- Design spec is at `docs/superpowers/specs/2026-07-28-mehmory-design.md` (read-only for this run)
- Run plan is at `.deliver/runs/2026-07-29-mehmory-runtime.md` (read-only)

## Architecture Summary

Three planes:

1. **Files** — markdown wiki under `~/.mehmory/`, edited via ordinary file operations
2. **Hooks** — TS scripts on SessionStart/UserPromptSubmit/Stop (fail-open, no LLM calls)
3. **Skills + schema** — SCHEMA.md conventions, plugin skills for judgment work

Core is **synchronous** (A9), **never exits** (A11), **ESM only** (A10), and **imports fs only in fs.ts + errors.ts** (A3).

## Error Codes

Error codes follow the `E_<SCREAMING_SNAKE>` pattern. At minimum, runs 1–3 provide:

- `E_CONFIG_PARSE` (actionable) — Invalid config.json, use defaults + warn
- `E_LOCK_TIMEOUT` (informational) — Lock held >5s, proceeded without it
- `E_DISTILL_LOSSY` (informational) — Unparseable transcript lines

Later subtasks register additional codes via `registerErrorCode(code, kind)` in `src/core/errors.ts`.

## Testing Strategy

- All tests run against temp `MEHMORY_HOME` (vitest setup guard)
- Worked examples from the spec are test vectors (done-when criterion 5)
- No pytest/mocha fixtures; one simple setup file per suite
- Test coverage: every numbered criterion has ≥1 assertion
