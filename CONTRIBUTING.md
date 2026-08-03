# Contributing to mehmory

Thanks for taking a look. mehmory is a small, deliberately boring TypeScript project — hooks,
a CLI, and markdown. Contributions are welcome; the bar is that a change stays boring.

## Before you write code

Open an issue first for anything beyond a typo or a one-line fix. mehmory has strong opinions
about scope (no embeddings, no MCP server, no external services), and it's cheaper to find out
in an issue than in a rejected pull request.

## Setup

Requires Node.js 22+ and pnpm 9+.

```bash
pnpm install   # also installs the Husky pre-commit hook
pnpm build
pnpm test
```

## Local checks

Run all four before you push — the pre-commit hook runs lint and test, and CI runs everything:

```bash
pnpm lint       # ESLint + Prettier check
pnpm test       # vitest
pnpm typecheck  # tsc strict mode
pnpm build      # tsup → dist/ and hooks/*.mjs
```

## Conventions

- **Commits** — conventional commits, `<type>(<scope>): <subject>`. Types: `feat`, `fix`,
  `docs`, `chore`, `refactor`, `test`.
- **Branches** — branch off `main`, one logical unit of work per pull request. Never commit
  directly to `main`.
- **TypeScript** — strict mode, no `any` in `src/` (enforced by a local ESLint rule).
- **Tests** — a bug fix needs a test that fails before the fix. See the Testing Strategy
  section of `AGENTS.md`.
- **Docs** — if a change alters behavior, commands, config keys, or error codes, update the
  affected doc in `docs/` in the same commit.

`AGENTS.md` is the deeper project guide: directory map, architecture summary, error codes, and
testing strategy. Read it before a non-trivial change.

## Pull requests

Describe what changed and why. CI must be green, and review comments resolved, before merge.

## License

By contributing, you agree that your contributions are licensed under the MIT License that
covers this project.
