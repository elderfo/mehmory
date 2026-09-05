# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`VERSION` is the canonical version source; `package.json`, `plugin.json`, and
`.claude-plugin/plugin.json` mirror it and tests enforce that they match.

## [Unreleased]

### Fixed

- **A resumed session is finalized again instead of being written off forever.** The
  finalization marker meant "this id is done", not "the transcript up to here is
  captured", so once a harness reused a session id on resume every later `SessionEnd` for
  it was a no-op and the entire resumed run was never captured. Seen in the wild: a marker
  five days older than the same session's live state. `SessionStart` now clears its own
  marker, and the marker carries the cursor so the resumed run reads on from where
  finalization stopped rather than re-distilling the whole transcript.

  Clearing the marker alone was not enough: the `log.md` idempotency tag is the *other*
  thing keyed by session id, so a resumed run's ending still read as a retry of the first
  and was skipped. Session state now carries a generation, and both the marker and that
  tag are keyed by id and generation. Generation 0 keeps the original tag spelling, so
  existing `log.md` content still matches.

- **A session in the middle of a long turn is no longer finalized while it is alive.**
  Idle detection read the state file's mtime, which only moves when a hook writes. A
  session waiting on a slow build or a long tool call fires no hooks, looked abandoned
  after 30 minutes, and was retired by the next session's start: state deleted, id marked
  done, everything it recorded afterwards dropped with no error anywhere.

  A session is now eligible only once its **transcript** has gone quiet as well. That is
  the file which actually grows while a session works -- Claude Code appends as it goes,
  and a Codex rollout is written incrementally too.

  Protect-only by design: a warm transcript defers the finalize to a later start, it never
  loses one. A rollout flushed after `SessionEnd` (#43) waits out the window from its own
  mtime, and a transcript that has not landed at all still falls back to the state mtime,
  so it stays eligible rather than waiting forever for a file that is absent.

- **Session-state writes are serialized.** `updateSessionState` was an unlocked
  read-modify-write, and hooks for one session really do overlap -- a Stop alongside a
  UserPromptSubmit, a `SessionEnd` racing a trailing Stop. The later writer discarded the
  earlier one's field, which could roll an advanced cursor backwards into a re-distill. A
  per-session lock now covers read and write together. It gets much tighter retry bounds
  than the project lock, which busy-waits: this one is taken on every prompt.

- **A project key that would escape the store is rejected at every read boundary.**
  `project_key` is joined under `<home>/projects/`, and now that it is written on every
  hook it reaches that join routinely. It is re-validated where it is read back -- the
  session state file and the queued distill payload -- alongside `host` and `agent`, and
  an `identity.aliases` value is validated too, since an alias is hand-written config that
  never passed through the remote-key sanitizer. Containment is now a separate check from
  the `host/owner/repo` shape check, so a one-segment alias such as `my-custom-key`
  remains valid.

- **An alias that is not a string no longer takes down every hook for that project.**
  `identity.aliases` is typed `Record<string, string>`, but `config.json` is user JSON and
  nothing enforced the value type at runtime. A number reached `String.prototype.split`
  and threw out of `resolveProjectKey`, which `runHook` catches fail-open -- so the hook
  produced no capture, no injection and no error the user would see.

- **A finalized session's state is no longer resurrected.** A hook firing after
  finalization rebuilt `.state/<id>.json` from scratch, cursor back at 0.
  `finalizeSession` short-circuits on the marker before it would delete state again, so
  the file lingered; if the marker aged out of `sweepSessionState` first -- it can, being
  the younger file -- the transcript was distilled a second time. The origin write now
  returns early for a finalized session, and the sweep keeps a marker as long as its state
  file is one the sweep could act on. An unparseable state file is invisible to both the
  sweep and `listPendingSessions`, so pinning a marker behind it would strand both files
  rather than protect anything.

### Removed

- **`setCachedProjectKey` is gone from `@elderfo/mehmory/core/session`.** It was the dead
  second writer for `project_key` and had no callers. `rememberSessionOrigin` now owns
  that field, and takes the project key as a required fourth argument -- a breaking change
  to the same subpath export for any consumer that called either function directly.

## [0.4.0] - 2026-08-25

### Added

- **Agent scopes: per-agent memory beside the shared project scope.** A third scope,
  `agents/<name>/`, holds what an agent *is* — its preferences, its style, what it has
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
  (ACP) writes its rollout *after* `SessionEnd` fires, so `finalizeSession` was retiring the
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

[Unreleased]: https://github.com/elderfo/mehmory/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/elderfo/mehmory/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/elderfo/mehmory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/elderfo/mehmory/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/elderfo/mehmory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/elderfo/mehmory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/elderfo/mehmory/releases/tag/v0.1.0
