# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`package.json` is the canonical version source; `.claude-plugin/plugin.json` mirrors it
and a test enforces that they match.

## [Unreleased]

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

[Unreleased]: https://github.com/elderfo/mehmory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/elderfo/mehmory/releases/tag/v0.1.0
