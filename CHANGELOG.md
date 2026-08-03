# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`package.json` is the canonical version source; `.claude-plugin/plugin.json` mirrors it
and a test enforces that they match.

## [Unreleased]

### Changed

- **The package is `mehmory` on npmjs, not `@elderfo/mehmory` on GitHub Packages.** GitHub
  Packages has no anonymous read, so the documented install told every reader to mint a
  `read:packages` token before they could try the tool — a private-repo arrangement that
  outlived the private repo. Installing is now `npm install -g mehmory`, with no registry
  configuration and no token. Releases authenticate with an `NPM_TOKEN` secret instead of the
  workflow's `GITHUB_TOKEN`, and the release-workflow test asserts the old registry and scope
  are absent rather than present, so a half-revert fails loudly.

  Anyone on the old package should replace it:
  `npm uninstall -g @elderfo/mehmory && npm install -g mehmory`.

## [0.2.1] - 2026-08-03

### Fixed

- **The Stop nudge asks for a silent save.** The block reason told the model what to save
  but never how loudly. One session answered it mid-brainstorm by reciting all twelve saved
  entries and appending a "where we left off" recap, which buried the dialogue it
  interrupted. The reason now asks for the append and one short sentence — no list, no
  recap, no status summary.
- **Capture now has a retention decision.** The distill pattern list ended in a
  `user_message` catch-all that matched every user turn unconditionally, so the keyword
  patterns above it only chose a label — nothing anywhere in the pipeline decided whether a
  turn was worth keeping. Menu picks and acknowledgements (`A`, `yes`, `Ship it`) were filed
  as memory; one store held seven consecutive one-letter entries. A turn now needs eight
  characters to reach the inbox. The floor deliberately errs toward keeping: it lets some
  multi-word ephemera through rather than risk discarding the user's own words, since a junk
  entry is visible and deletable at integrate time and a dropped fact leaves no signal.
- **Harness notification blocks are stripped like the other machine text.**
  `<task-notification>` and `<system-reminder>` joined the slash-command and bash envelopes
  in the noise filter. Without them a single agent-completion notice was filed verbatim, and
  a run that dispatched several subagents wrote a near-identical entry for each.
- **The noise filter no longer misses a differently-spelled tag, nor eats prose around one.**
  It matched only a bare lowercase tag, so `<Task-Notification>`, `<task-notification id="1">`
  and a block truncated before its closing tag all passed through and were filed verbatim —
  machine text that later gets re-injected into a session. Matching is now case-insensitive,
  tolerates attributes, and discards an unterminated block. It is also anchored to the start
  of a line, so a turn that quotes a tag name inline while discussing it keeps its prose
  instead of having everything between the two mentions deleted.

## [0.2.0] - 2026-08-01

### Added

- **Codex CLI support, alongside Claude Code.** mehmory is a two-harness memory layer now,
  not a Claude-Code-only plugin: `mehmory init --host codex [--uninstall]` wires the same
  four capture hooks and the six skills into `$CODEX_HOME`, reading and writing
  `hooks.json`/`config.toml` as merge-only edits so entries owned by other tools are never
  touched. There is **one** plugin manifest (`.claude-plugin/plugin.json` +
  `marketplace.json`) serving both harnesses — Codex's `plugin marketplace add`/`plugin add`
  read the same files Claude Code does, so a second manifest was deliberately not created.
  A per-harness `hosts.claude-code.enabled` / `hosts.codex.enabled` config toggle lets you
  adopt the Codex side gradually. Redaction and `purge` reach content from either harness
  identically — there is one store, not one per harness.
- **Project website** — a VitePress site under `site/`, deployed to GitHub Pages on every
  push that touches it. Carries the pitch, a five-minute quickstart, and a "how it works"
  walkthrough of the three planes, the retrieval trade-off, and the context budget. Deep
  reference (`docs/CLI.md`, `CONFIG.md`, `PRIVACY.md`, `TROUBLESHOOTING.md`, `UPGRADE.md`,
  `WORLD_MODEL.md`) is linked from the site rather than duplicated into it, so there is one
  copy of every fact. Build it locally with `pnpm docs:dev`. The site is not part of the
  published package — `files` in `package.json` is unchanged.

### Fixed

- **Slash-command and bash-mode turns are no longer filed as memory.** Claude Code writes
  them as ordinary `type: 'user'` records with no `isMeta` flag, so distill treated a
  `/reload-plugins` echo or a `<local-command-stdout>` block as something the user said —
  an inbox, and eventually wiki pages, built from command transcripts. The envelope blocks
  are now stripped in place: `<command-args>` survives, because `/orchestrate <a whole
  project brief>` puts real intent there, and so does prose the user typed after an echo in
  the same record.

### Known limitations

- **Whether Codex trusts a freshly written mehmory hook on first run is unverified** on
  Codex CLI 0.146.0 — `config.toml`'s `trusted_hash` mechanism was not measurable without a
  real user configuration. See `docs/TROUBLESHOOTING.md`.
- **The `PreCompact` hook's payload on Codex is unverified**; finalization relies on the
  next-session-start path instead of on `PreCompact` firing.
- **The Stop nudge does not render under `codex exec`** (non-interactive) — capture still
  happens, but a non-interactive run has no follow-up turn to show the nudge in.
- `mehmory onboard` mines only `~/.claude/projects/*/`; there is no Codex-transcript
  equivalent to backfill from.

## [0.1.0] - 2026-08-01

First released version. Everything below shipped across the three build runs that
preceded it; `0.0.1` was scaffolding and was never published.

### Added

- **Markdown wiki memory store** at `~/.mehmory` (or `$MEHMORY_HOME`) — a git-backed
  directory of pages that a Claude Code session reads and writes with ordinary file
  operations. No embeddings, no MCP server, no external services.
- **Five Claude Code hooks** — `SessionStart` injects relevant memory into the session,
  `UserPromptSubmit` matches pages against the prompt, `Stop` and `SessionEnd` capture
  what happened, `PreCompact` preserves context before compaction. Every hook fails open:
  an error is logged to `errors.log` and the session continues unaffected.
- **Model-driven skills** — `integrate` turns captured inbox entries into wiki pages,
  `remember` records something deliberately mid-session, `lint` judges whether pages are
  still true, `onboard-session` seeds a new project, and `pause`/`resume` bracket work you
  intend to come back to.
- **`mehmory` CLI** — `init`, `onboard`, `search`, `status`, `stats`, `doctor`, and
  `purge`, each with a `--json` envelope for scripting.
- **Search across pages, archive, and log** as a single scan, with a documented cap and
  warning rather than a silent truncation.
- **Secret redaction** on capture, applied before anything reaches the store.
- **Decay classes** — pages carry an optional `decay` field (`evergreen`, `ephemeral`, or
  the default) that governs how aggressively they age. Default pages are demoted after 60
  days and archived after 90; ephemeral content is refreshed or deleted on every integrate
  pass rather than on a timer; evergreen pages are exempt from mechanical decay.
- **`schema_version` drift warning** in `doctor`, so a store written by an older plugin
  version surfaces an upgrade signal instead of failing quietly.
- **Documentation** — `docs/CLI.md`, `docs/CONFIG.md`, `docs/PRIVACY.md`,
  `docs/TROUBLESHOOTING.md`, `docs/UPGRADE.md`, and `docs/WORLD_MODEL.md`, with tests
  that keep the CLI reference and the README quickstart honest against the built binary.
- **Publishing to GitHub Packages** — tagging `v*` builds the hook bundles into the
  tagged tree and publishes `@elderfo/mehmory` to the owner's registry.

### Known limitations

- Installing the CLI from GitHub Packages requires a GitHub token with `read:packages`;
  the registry has no anonymous read, even for a public package. See the README.
- `project.md` only carries integrated content after the first `/mehmory:integrate`, so
  the session that already knows your project is the *second* one, not the first.
- No release has been published before this one, so the tag-driven publish path runs
  against the live registry for the first time here.

[Unreleased]: https://github.com/elderfo/mehmory/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/elderfo/mehmory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/elderfo/mehmory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/elderfo/mehmory/releases/tag/v0.1.0
