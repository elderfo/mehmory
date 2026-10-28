# Changelog

All notable changes to this project are documented here.

release-please writes this file from Conventional Commit PR titles when a release PR
merges; do not edit it by hand. Sections up to 0.4.0 were written by hand in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0](https://github.com/elderfo/mehmory/compare/v0.4.0...v0.5.0) (2026-10-28)


### Features

* **pi:** add Pi as a third host ([#56](https://github.com/elderfo/mehmory/issues/56)) ([77781af](https://github.com/elderfo/mehmory/commit/77781af64287bf0cf4d9bab43dbc49b238790abd))


### Bug Fixes

* **capture:** finalize abandoned sessions under their own project ([8c6631e](https://github.com/elderfo/mehmory/commit/8c6631e98d125acef08b484dd15fabd287e0851c))
* **capture:** keep captured deltas durable and resume swept sessions ([#66](https://github.com/elderfo/mehmory/issues/66)) ([db0c3c1](https://github.com/elderfo/mehmory/commit/db0c3c1a2ebe00e41e7f36fa781829d3a740866c))
* **cli:** purge every copy of the target and keep onboard progress ([#65](https://github.com/elderfo/mehmory/issues/65)) ([26e935c](https://github.com/elderfo/mehmory/commit/26e935ced81aec094c2f71662cf789bb613904a9))
* **codex:** diagnose the hook-trust gate and wire SessionEnd ([#53](https://github.com/elderfo/mehmory/issues/53)) ([51fbd3d](https://github.com/elderfo/mehmory/commit/51fbd3da32a07a906fd0282f936da50ee5b07311))
* **codex:** never corrupt Codex config on install or uninstall ([#68](https://github.com/elderfo/mehmory/issues/68)) ([bcfeb9a](https://github.com/elderfo/mehmory/commit/bcfeb9ab78521357db037358a827408fbbe91d75))
* **lint:** close architecture rule gaps that let violations pass ([#63](https://github.com/elderfo/mehmory/issues/63)) ([712b745](https://github.com/elderfo/mehmory/commit/712b745c399dac3ee25c558c4b0c094983700419))
* **lock,queue:** stop double claims and lost mutual exclusion ([#64](https://github.com/elderfo/mehmory/issues/64)) ([b52079d](https://github.com/elderfo/mehmory/commit/b52079d0955937569705af791842d35872689eb7))
* **memory:** respect decay classes and the injection budget contract ([#70](https://github.com/elderfo/mehmory/issues/70)) ([9641bdd](https://github.com/elderfo/mehmory/commit/9641bdd56650ed5debdd82de2c2f5d71f014dee3))
* **secrets:** close credential leaks and bound redaction time ([#69](https://github.com/elderfo/mehmory/issues/69)) ([e5f50c9](https://github.com/elderfo/mehmory/commit/e5f50c9e1fffc38bbcb3d9957b85d6535f1aa861))
* **security:** harden storage and integration boundaries ([ec68eab](https://github.com/elderfo/mehmory/commit/ec68eab552ea94ecf9b89092c033389d41de7364))
* **session:** harden session lifecycle finalization ([bc22d50](https://github.com/elderfo/mehmory/commit/bc22d50090c9c9b6abec12be3c762bc0ce34208a))
* **stats:** record the real project for suppressed hook calls ([#59](https://github.com/elderfo/mehmory/issues/59)) ([65bcdf8](https://github.com/elderfo/mehmory/commit/65bcdf894bffa44f4eed55689e250101a69aeec8))
* **storage:** durable atomic writes, isolated git, lossless inbox encoding ([#67](https://github.com/elderfo/mehmory/issues/67)) ([976d218](https://github.com/elderfo/mehmory/commit/976d218ff8c7152af23e5dad3aee7d80a1527fcd))

## [0.4.0] - 2026-08-25

### Added

- **Agent scopes: per-agent memory beside the shared project scope.** A third scope,
  `agents/<name>/`, holds what an agent _is_ — its preferences, its style, what it has
  learned about itself — alongside `global/` (facts about you) and `projects/<key>/` (facts
  about the repo). An agent declares its name through `MEHMORY_AGENT`, falling back to the
  new `identity.agent` config key; instances that share a model can then accumulate distinct
  selves instead of pooling into one. Captured entries carry an `agent=` stamp,
  and `/mehmory:integrate` files self-facts into that agent's scope. A named agent's own
  content is injected at `SessionStart` as a fourth share of the existing
  `injection.budget_tokens`, which stays a hard cap — naming an agent does not raise it.
  Addressing agent scopes from `search`, `stats` and `purge` is not part of this change.

  An agent that declares no name is unaffected: capture, recall, injection budget and
  on-disk layout are all unchanged, and no agent scope is created for it.

- **Portable Agent Plugins packaging.** The root `plugin.json` and `skills/` directory now
  expose the Agent Plugins v1.0.0 surface while preserving Claude Code's compatibility
  manifest and lifecycle hooks.

### Changed

- **`FORMAT_VERSION` is 3 and `schema_version` is 2.** Inbox entries gained an optional
  `agent=` field; older entries are not rewritten and still parse. Downgrading is not
  symmetric — an older build cannot parse a line carrying `agent=` at all, so integrate
  before rolling back. `SCHEMA.md`'s scope rule gained a third clause, so `doctor` now
  reports drift against a customized copy; adopt the new rule to route agent facts.

- **The Stop nudge no longer reads as a hook error on Claude Code.** The once-per-threshold
  request to save learnings is carried as `hookSpecificOutput.additionalContext` rather than
  `{"decision": "block"}`. Both block the turn identically — same re-invoke, same
  `stop_hook_active` guard on the next Stop — but the transcript now shows
  `Stop hook feedback: …` instead of `Stop hook error: …`, with no error toast. The reason
  text also dropped from ~700 to ~310 characters: the literal `inbox-tx` command is now
  emitted only for Codex, where skill invocation is not a slash command. Codex keeps
  `{"decision": "block"}`, the only shape its Stop event accepts.

- **Skill metadata is portable across clients.** Skill `allowed-tools` values now use the
  Agent Skills space-separated format, and the generated hook chunks are tracked so clean
  marketplace checkouts contain every runtime bundle.

### Fixed

- **ACP sessions no longer lose their transcript to a finalize race.** The Claude Agent SDK
  (ACP) writes its rollout _after_ `SessionEnd` fires, so `finalizeSession` was retiring the
  session and capturing nothing when the file had not yet reached disk. It now defers a
  named-but-absent transcript, leaving the session pending so the next start's sweep captures
  it once the rollout lands; a transcript that never appears still retires after the sweep's
  idle window.

### Security

- **Skills no longer install npm packages implicitly.** Missing `mehmory` binaries now stop
  with an explicit installation request instead of running an unpinned global install.

## [0.3.1] - 2026-08-07

The first release whose plugin installs actually work. Every 0.x release before this one
shipped a `hooks.json` pointing at bundles that were not in the installed tree, so the hooks
never ran — reinstall the plugin to pick this up.

### Fixed

- **Every hook was dead in any plugin install.** `hooks.json` registered five commands
  pointing at `hooks/*.mjs` bundles that were not in the installed plugin, so all five hooks
  — SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd — exited 1 with
  `MODULE_NOT_FOUND`. Nothing was captured, nothing was injected, and because the host
  reports that as a hook failure rather than a broken plugin, it looked like memory was
  simply empty.

  The bundles were gitignored on `main`, and `release.yml` force-added them onto the `v*`
  tag to compensate. The tag was correct — `v0.3.0` carries all six files — and it never
  reached anyone: the plugin marketplace clones the repository's **default branch**, not the
  tag, so installs recorded `main`'s HEAD and got a `hooks/` directory containing only
  `hooks.json`.

  `hooks/*.mjs` is now committed on `main` (A25 in `docs/WORLD_MODEL.md`) and the tag
  inherits it. Committed build output can go stale, so CI rebuilds and fails if `hooks/`
  differs by a byte; the bundles are content-addressed and reproduce identically across
  machines, so that gate is deterministic. A test now asserts each bundle is **tracked by
  git** rather than merely present on disk — the previous `existsSync` check was satisfied by
  any local `pnpm build`, which is why the outage shipped.

  The two distribution paths update at different moments. **Plugin users reinstall to pick
  this up as soon as it is on `main`** — the marketplace installs from the default branch, so
  no tag is involved, which is the whole point of the change. The npm package still updates
  on the `v0.3.1` tag. `dist/` stays gitignored, because a marketplace install never puts the
  `mehmory` CLI on `PATH` regardless — that surface is npm's.

### Security

- **A crafted `config.json` could poison every object in the process.** `JSON.parse` turns
  `__proto__` into a real own enumerable property, and the config merge treated it as
  ordinary data — `'__proto__' in target` is true through the prototype chain, so the
  recursion wrote straight into `Object.prototype`. Since config is merged into defaults on
  every hook run, one poisoned file leaked a property onto every object mehmory touched.
  Prototype-reaching keys (`__proto__`, `constructor`, `prototype`) are now dropped, and the
  merge tests own-property membership instead of walking the chain.

- **Inbox text ending a comment early.** `serializeInboxEntry` neutralized `-->` but not
  `--!>`, which HTML also accepts as a comment terminator, leaving one spelling live in text
  written into a markdown file. Both are escaped now, reversibly — a round-trip still returns
  the user's exact words.

  Both were surfaced by CodeQL against the newly committed bundles and fixed at the source
  rather than suppressed, so the pre-existing alerts on `src/schema/format.ts` and
  `src/core/config.ts` clear too.

### Removed

- **The `build-tag` release job**, along with the workflow's write access to repository
  contents. It existed only to force-push bundles onto the tag; with them on the branch it
  has nothing left to do, and `release.yml` no longer needs a token that can rewrite refs.

## [0.3.0] - 2026-08-04

This is the first release published to npmjs.org, and the first one installable without a
token. It is also the first release since the repository became public.

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

  `@elderfo/mehmory` stays published on GitHub Packages at 0.2.1 rather than being deleted —
  removing it would break existing installs, and the README documents the switch. The
  `@mehmory/mehmory` name on npmjs is a reservation stub containing no code; it exists so the
  scope can't be claimed by someone else, and points at `mehmory`.

### Added

- **Contributor and security docs**, now that the repository is public: `CONTRIBUTING.md`,
  `SECURITY.md` (private vulnerability reporting, with the secret filter named as the
  security-relevant surface), `CODE_OF_CONDUCT.md`, issue forms, and a pull request template.

### Security

- **CI runs on fork pull requests**, so `ci.yml` declares `permissions: {}` at the workflow
  level and `contents: read` on the job instead of inheriting the repository default. Secret
  scanning, push protection, and Dependabot alerts are enabled on the repository.

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
  the session that already knows your project is the _second_ one, not the first.
- No release has been published before this one, so the tag-driven publish path runs
  against the live registry for the first time here.

[0.4.0]: https://github.com/elderfo/mehmory/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/elderfo/mehmory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/elderfo/mehmory/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/elderfo/mehmory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/elderfo/mehmory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/elderfo/mehmory/releases/tag/v0.1.0
