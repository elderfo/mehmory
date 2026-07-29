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
│   │   └── store.ts           # Store layout init (F)
│   ├── schema/
│   │   └── format.ts          # Format constants, versioned template (A, F)
│   ├── transcript/
│   │   └── distill.ts         # JSONL reader, parsing (D)
│   ├── redact.ts              # Secret filter (E)
│   ├── tokens.ts              # Token estimation (E)
│   └── injection.ts           # Context builder, cap enforcement (E)
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
├── eslint.config.js           # Flat config + custom rules (A)
├── .prettierrc                 # Code formatting (A)
├── .husky/                     # Pre-commit hooks (A)
├── .gitignore                  # node_modules, dist, .deliver/SESSION.md
└── docs/
    └── WORLD_MODEL.md         # Architectural decisions A1–A11
```

## Subtask Ownership

- **A** (this module): `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.husky/`, `.gitignore`, `AGENTS.md`, `docs/WORLD_MODEL.md`, `src/core/home.ts`, `src/core/errors.ts`, `src/schema/format.ts`, `test/setup.ts`, `eslint-rules/`, and all tests for A modules.

- **B**: `src/core/identity.ts`, `src/core/config.ts` — resolveProjectKey, loadConfig, MEHMORY_HOME, alias map.

- **C**: `src/core/fs.ts`, `src/core/lock.ts`, `src/core/git.ts`, `src/core/queue.ts` — atomic writes, locking, git, job queue.

- **D**: `src/transcript/distill.ts`, `src/core/cursor.ts` — JSONL reader, distill patterns, cursor.

- **E**: `src/redact.ts`, `src/tokens.ts`, `src/injection.ts` — secret filter, token estimation, context builder.

- **F**: `src/schema/format.ts` (shared with A), `src/core/store.ts`, `assets/SCHEMA.md` — store init, schema versioning.

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
- Branches off `feat/foundation`, never directly to `main`
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
- Run plan is at `.deliver/runs/2026-07-29-mehmory-foundation.md` (read-only)

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
