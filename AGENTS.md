# mehmory — Project Guide

## Directory Structure

```
mehmory/
├── src/
│   ├── core/
│   │   ├── home.ts            # Store root path, env overrides (A); run-4: codexHome() ($CODEX_HOME, default ~/.codex)
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
│   │   ├── inbox.ts           # run 2: inbox entry read/write, snapshot-clear (A)
│   │   ├── session.ts         # run 2: per-session capture state, cursor scoping (A)
│   │   ├── decay.ts           # run 2: recency decay/archive file ops (A)
│   │   ├── stats.ts           # run 2: stats.jsonl writer (A)
│   │   ├── match.ts           # run 2: grep-based full-text matcher (A)
│   │   ├── capture.ts         # run 2: scope paths, injection composition, delta capture, job payloads — hook plumbing (B)
│   │   ├── hook.ts            # run 2: stdin/stdout/timing/stats/fail-open adapter runner (B)
│   │   ├── host.ts            # run-4: which harness invoked this hook, threaded not read ambiently (A21, A23)
│   │   ├── codex-install.ts   # run-4: wire/unwire mehmory in $CODEX_HOME (hooks.json, config.toml, skills) — merge-only edits, never rewrites
│   │   └── inbox-tx.ts        # run-4: transactional inbox helper logic shared by hooks/inbox-tx.mjs and `mehmory inbox-tx` (A15, A17)
│   ├── hooks/                 # run 2: thin hook adapters, bundled to hooks/*.mjs (B)
│   │   ├── session-start.ts
│   │   ├── user-prompt-submit.ts
│   │   ├── stop.ts             # run-3: reads stop.capture_threshold from config (L)
│   │   ├── pre-compact.ts
│   │   ├── session-end.ts
│   │   └── inbox-tx.ts        # bundled transactional helper for skills; run-3: config-aware redact() call site (L)
│   ├── schema/
│   │   └── format.ts          # Format constants, versioned template (A, F); run-2: inbox entry serialization (A); run-3: index-line format constant (L)
│   ├── transcript/
│   │   ├── reader.ts          # Claude Code JSONL transcript reader, incremental parsing (D)
│   │   ├── codex.ts           # Codex rollout reader: event envelope → normalized record
│   │   └── host.ts            # readSession(path, host) — the only harness branch there is
│   ├── distill/
│   │   ├── patterns.ts        # Normative distill patterns (D, A7)
│   │   └── distill.ts         # Record → inbox entry distillation (D)
│   ├── core/                  # (continued) run-3 additions:
│   │   └── scopes.ts          # run 3: project discovery + alias resolution, one scope grammar (L)
│   └── cli/                   # run 3: the CLI — argument parsing, exit codes, --json envelope;
│                               # no business logic (A17). Bundled to dist/cli.mjs, excluded from
│                               # the library's importable entry.
│       ├── index.ts           # parsing, exit codes, envelope, help/version, command registry (C1)
│       └── commands/
│           ├── init.ts        # (C1)
│           ├── doctor.ts      # (C1)
│           ├── status.ts      # (C1)
│           ├── stats.ts       # (C1)
│           ├── search.ts      # (S)
│           ├── onboard.ts     # (C2)
│           ├── purge.ts       # (C2)
│           └── inbox-tx.ts    # run-4: `mehmory inbox-tx` — same append/snapshot/clear contract as
│                               # hooks/inbox-tx.mjs, via src/core/inbox-tx.ts (issue #17)
├── hooks/                     # run 2: plugin hook dir — committed hooks.json plus
│                               # gitignored *.mjs bundles built from src/hooks/*.ts (B)
├── skills/                    # run 2: plugin skills — integrate, lint, onboard-session,
│                               # remember, pause, resume (C)
├── .claude-plugin/            # run 2: plugin.json manifest (C); run-3: marketplace metadata (X)
├── site/                      # VitePress marketing + docs site, deployed to GitHub Pages.
│   │                           # Hype/landing content only — deep reference stays in docs/*.md
│   │                           # and is linked out to, never mirrored here.
│   ├── .vitepress/config.mts  # nav, sidebar, `base: '/mehmory/'`, local search
│   ├── index.md               # home layout: hero + feature grid
│   ├── why.md                 # the pitch, including the honest-limits section
│   ├── quickstart.md          # condensed README "First 5 minutes"
│   └── how-it-works.md        # three planes, retrieval trade-off, context budget
├── .github/
│   ├── ISSUE_TEMPLATE/        # bug_report.yml, feature_request.yml, config.yml (blank issues
│   │                           # off; links to TROUBLESHOOTING.md and private vuln reporting)
│   ├── pull_request_template.md # local-checks + docs + conventional-commits checklist
│   └── workflows/             # run 3: ci.yml (install/build/lint/test/typecheck on push+PR),
│                               # release.yml (v* tag → build → force-add hooks/*.mjs into the
│                               # tagged tree; npm publish job inert this run) (X);
│                               # pages.yml (site/** on main → vitepress build → Pages deploy)
├── test/
│   ├── setup.ts               # Vitest setup, MEHMORY_HOME guard (A)
│   ├── home.test.ts           # home module tests
│   ├── errors.test.ts         # errors module tests with worked examples
│   ├── format.test.ts         # format constants tests
│   ├── docs-consistency.test.ts # run 3: docs ↔ binary, both directions (Integration); run-4:
│   │                           # Codex surface covered in both directions too
│   ├── quickstart.test.ts     # run 3: scripted TTHW gate against dist/cli.mjs (Integration)
│   ├── host.test.ts           # run-4: src/core/host.ts resolution
│   ├── hooks-host.test.ts     # run-4: hook adapters branch on the resolved host, not env-sniff
│   ├── hooks-codex.test.ts    # run-4: hook adapters against Codex-shaped payloads
│   ├── transcript-codex.test.ts # run-4: Codex rollout reader normalization
│   ├── cli-init-codex.test.ts # run-4: `mehmory init --host codex` install/uninstall
│   ├── cli-inbox-tx.test.ts   # run-4: `mehmory inbox-tx` CLI command
│   ├── inbox-tx.test.ts       # run-4: src/core/inbox-tx.ts append/snapshot/clear
│   └── fixtures/transcripts/codex-*.jsonl, codex-*.distilled.json # run-4: Codex rollout fixtures
├── eslint-rules/
│   └── index.js               # Custom ESLint rules (A3, A9, A11, U2); run-3: custom/no-cli-imports (L)
├── package.json               # pnpm workspace, all devDeps (A); run-3: bin/files/engines/repository/license (L)
├── tsconfig.json               # strict: true, no any (A)
├── tsup.config.ts              # ESM-only output (A10); run-3: CLI bundle entry, splitting: false (L)
├── vitest.config.ts             # Test runner config (A)
├── eslint.config.js             # Flat config + custom rules (A); run-2: full strictTypeChecked, hooks/ ignored (D)
├── .prettierrc                 # Code formatting (A)
├── .husky/                     # Pre-commit hooks: lint, test, typecheck (A, D)
├── .gitignore                  # node_modules, dist, .deliver/, /hooks/*.mjs (D)
├── LICENSE                     # run 3: MIT, Christopher Freddy Getsfred (X)
├── README.md                   # run 3: "First 5 Minutes" quickstart (X)
├── CONTRIBUTING.md             # setup, local checks, conventions for outside contributors
├── CODE_OF_CONDUCT.md          # Contributor Covenant 2.1
├── SECURITY.md                 # private vuln reporting; scope centers on the secret filter
└── docs/
    ├── WORLD_MODEL.md         # Architectural decisions A1–A11; run-2: A12–A16; run-3: A17–A21 (C, X)
    ├── CLI.md                 # run 3: every command, flag, default, exit code (X)
    ├── TROUBLESHOOTING.md     # run 3: indexed by E_<CODE> + stable consequence sentence (X)
    ├── PRIVACY.md             # run 3: secret-filter limits, purge reach, uninstall-vs-purge (X)
    ├── CONFIG.md              # run 3: all 14 config groups, real defaults, unhonored keys (X)
    ├── UPGRADE.md             # run 3: schema_version drift (X)
    └── agents/                # where the engineering skills look for repo conventions:
        ├── issue-tracker.md   # GitHub Issues via `gh`
        ├── triage-labels.md   # the five canonical triage roles
        └── domain.md          # doc-consumer rules; points ADRs at WORLD_MODEL.md
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

### Run 2 — hooks, skills, plugin packaging

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

### Run 3 — CLI, search, docs, CI

Letters below are run-3 subtask units, distinct from the run-1/run-2 letters above (both
runs reuse A–F/D–C; check the run's plan doc for which is which).

- **L — library + packaging.** Config threading (`injection.budget_tokens`,
  `secrets.patterns`/`whitelist`, new `stop.capture_threshold`) plus the two permitted
  hook call-site updates it forces (`src/hooks/stop.ts`, `src/hooks/inbox-tx.ts`);
  error-registry additions and the actionable-fix audit, `peekWarnings()`, the
  `errors.ts` CLI-mode flag; `initStore` gitignore + empty config; the index-line format
  constant in `format.ts`; `src/core/scopes.ts` (project discovery + alias resolution);
  the `eslint-rules/` import-boundary rule; `package.json` (`bin`/`files`/`engines`/
  `repository`/`license`) and `tsup.config.ts` (CLI bundle entry); shared test
  infrastructure. Unlocks S, C1, C2, X.
- **S — search.** `src/core/search.ts` (multi-corpus scan, scoring, snippets, file cap)
  and `src/cli/commands/search.ts`.
- **C1 — CLI framework + read commands.** `src/cli/index.ts` (parsing, exit codes,
  envelope, help/version, the complete command registry plus stub files for every
  command), `init`, `doctor`, `status`, `stats`.
- **C2 — write commands.** `onboard` (dry-run, resume, project cap, stub `project.md`,
  zero-transcript path) and `purge` (scopes, tokens, export, commit-failure path), plus
  `src/core/onboard.ts`.
- **X — docs, CI, amendments.** `README.md`, `docs/{CLI,TROUBLESHOOTING,
  PRIVACY,CONFIG,UPGRADE}.md`, `LICENSE`, `.github/workflows/{ci,release}.yml`,
  `.claude-plugin/plugin.json` metadata, the spec's KPI rewrite and
  `## Run-3 amendments`, `docs/WORLD_MODEL.md` A17–A21, this file's run-3 sections.
- **Integration unit.** Merges the tails; owns the bidirectional docs↔binary
  consistency test and `test/quickstart.test.ts` — both spawn `dist/cli.mjs`, which does
  not exist inside any single parallel worktree.

Unlock order: L → (S, C1, C2, X in parallel) → Integration.

## Project Commands

- `pnpm install` — Install dependencies
- `pnpm build` — Build ESM output via tsup (→ dist/)
- `pnpm lint` — Run ESLint + Prettier check
- `pnpm test` — Run vitest
- `pnpm typecheck` — Run tsc strict mode
- `pnpm prepare` — Install Husky hooks (runs on `pnpm install`)
- `pnpm docs:dev` — Run the marketing/docs site locally (VitePress dev server)
- `pnpm docs:build` — Build the site (→ site/.vitepress/dist)
- `pnpm docs:preview` — Serve the built site

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
- Run plan is at `.deliver/runs/2026-07-29-mehmory-runtime.md` (read-only, local — `.deliver/`
  is untracked, so this path exists only in a working copy that has it)

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

Later subtasks register additional codes by adding a key to the flat `ERROR_KINDS` object in
`src/core/errors.ts` — there is no `registerErrorCode` function.

## Testing Strategy

- All tests run against temp `MEHMORY_HOME` (vitest setup guard)
- Worked examples from the spec are test vectors (done-when criterion 5)
- No pytest/mocha fixtures; one simple setup file per suite
- Test coverage: every numbered criterion has ≥1 assertion
- **Retrieval changes are judged by the golden set, not by feel.**
  `test/fixtures/golden-queries.json` holds a fixed miniature wiki plus the queries a user
  would type at it; `test/retrieval-golden.test.ts` reports Recall@1 and Recall@3 over it.
  Run it before and after any change to weighting, tokenizing, stopwords or scoring, and
  record the new numbers in that file's measurement block. The paraphrase split (queries
  sharing no vocabulary with their target page) is reported separately — it is the
  measured size of what keyword matching cannot do.
- **Always-on context is budgeted, and the budget is a test.** Two things load before the
  user types anything: the `SessionStart` injection frame (capped at
  `injection.budget_tokens`, asserted in `test/injection.test.ts`) and the six skill
  `description` fields (~650 tokens, capped at 800 combined / 160 each, asserted in
  `test/plugin-skills-layout.test.ts`). Both ceilings are deliberate. Raising one is a
  decision to make in a commit that says why, not something to discover after the fact.

## Agent skills

### Issue tracker

GitHub Issues on `elderfo/mehmory`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label named after its role. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. ADRs live in `docs/WORLD_MODEL.md`, not `docs/adr/`. See `docs/agents/domain.md`.
