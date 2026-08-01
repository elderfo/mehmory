# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This repo is **single-context**, but it does not use the default `CONTEXT.md` + `docs/adr/` layout.
Its equivalents already exist under different names — read those, not the defaults:

- **`AGENTS.md`** at the repo root — annotated directory structure, per-module ownership, project
  commands, conventions, and the testing strategy. This is the orientation document; read it before
  exploring the tree, and do not re-derive the structure with directory reads.
- **`docs/WORLD_MODEL.md`** — the ADRs. Decisions are numbered `A1`–`A22` and grouped by the run that
  introduced them, plus per-run amendments. **This file is `docs/adr/` for this repo.** There is no
  `docs/adr/` directory, and a new one should not be created — it would split the decision record.
- **`CONTEXT.md`** does not exist. mehmory's vocabulary is defined across `AGENTS.md`,
  `docs/WORLD_MODEL.md`, and the reference docs below. If a glossary is ever wanted, it belongs at the
  root as `CONTEXT.md` alongside these, not replacing them.

Reference docs, read when the work touches their surface:

- **`docs/CLI.md`** — every command, flag, default, and exit code
- **`docs/CONFIG.md`** — all config groups, real defaults, and keys that are not honored
- **`docs/TROUBLESHOOTING.md`** — indexed by `E_<CODE>` plus a stable consequence sentence
- **`docs/PRIVACY.md`** — secret-filter limits, purge reach, uninstall vs purge
- **`docs/UPGRADE.md`** — `schema_version` drift

If a file listed here doesn't exist, **proceed silently**. Don't flag its absence and don't suggest
creating it upfront.

## Working directories

Gitignored, not shipped, but they hold real history — check before assuming there is none:

- `.work/` — in-progress worker scratch state for the current run
- `.research/` — investigation notes, prototypes, and spike verdicts gathered while planning or debugging
- `.swarm/reports/` — per-unit swarm run reports
- `.scratch/` — one-off run reports

## Use the project's vocabulary

When your output names a domain concept — in an issue title, a refactor proposal, a hypothesis, a test
name — use the term this project already uses: **store**, **wiki**, **page**, **index line**,
**inbox**, **entry**, **capture**, **distill**, **injection**, **routing block**, **scope**,
**project key**, **hook**, **skill**, **fail-open**, **decay**, **archive**, **integrate**, **lint**.

Don't drift to synonyms. In particular: it is a **store**, not a database; **pages**, not notes;
**capture**, not logging; **injection**, not prompting.

If the concept you need has no established term here, that's a signal — either you're inventing
language the project doesn't use (reconsider), or there's a real gap worth naming deliberately.

## Flag ADR conflicts

The ADRs in `docs/WORLD_MODEL.md` are load-bearing and several are enforced by custom ESLint rules in
`eslint-rules/` and by tests. If your output contradicts one, surface it explicitly rather than
silently overriding:

> _Contradicts A12 (hooks are thin adapters) — but worth reopening because…_

Decisions most likely to constrain new work: **A2** (fail-open), **A4** (format constants are code),
**A5** (project identity), **A7** (fixtures are normative), **A8** (fail-open bounds), **A12** (thin
hook adapters), **A14** (code-owned inbox line format), **A15** (transactional writes go through the
bundled helper), **A17** (the CLI is a second thin consumer, not a second implementation), **A21**
(config is threaded, never ambient).

## Keep the docs moving with the code

Repo convention: when a change alters behavior, public APIs, commands, or structure, the affected docs
change in the **same commit** — including the `AGENTS.md` structure overview. `test/docs-consistency.test.ts`
enforces part of this in both directions.
