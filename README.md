# mehmory

Hook-enforced, model-maintained markdown wiki memory for **Claude Code and Codex CLI**. A
deliberately "meh"-tier improvement in harness memory and continuity, built from boring parts:
your project's memory is a git-backed directory of markdown at `~/.mehmory` that a Claude Code
or Codex CLI session reads and writes with ordinary file operations. No embeddings, no MCP
server, no external services.

Website: <https://elderfo.github.io/mehmory/> — the pitch, the quickstart, and how it works.

See `docs/CLI.md` for the full command reference, `docs/CONFIG.md` for every config key,
`docs/TROUBLESHOOTING.md` for error messages, `docs/PRIVACY.md` for the secret filter's
limits and how deletion works, and `docs/UPGRADE.md` for `schema_version` drift.

## First 5 minutes

This flow is ordered deliberately: **no step below claims mehmory knows something it can't
yet know.** `onboard` seeds raw material into the inbox and a one-line stub `project.md` — it
does not build the wiki. The wiki gets built by `/mehmory:integrate`, which is model-driven,
in-session work. So the first session after onboarding sees only a stub; the session *after
that first integrate* is the one where the project's memory is actually there waiting for
you. If you've read that mehmory's magical moment is "the very first session already knows
your project" — that's wrong for this ordering, and this README is the corrected version.

### 1. Install

The CLI publishes to GitHub Packages, not npmjs.org, so npm needs to be told where the
`@elderfo` scope lives and given a GitHub token with `read:packages`:

```bash
npm config set @elderfo:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <your-github-token>
npm install -g @elderfo/mehmory
```

The token is required even for a public package — GitHub Packages has no anonymous read.

Then wire mehmory into whichever harness (or both) you use. The two paths differ, because the
harnesses themselves differ — pick the one for the harness you're setting up:

**Claude Code** installs the plugin from the marketplace:

```
/plugin marketplace add elderfo/mehmory
/plugin install mehmory@mehmory
```

(`mehmory init`, in the next step, prints this pinned command too if it doesn't find the
plugin already installed.) These are Claude Code slash commands — type them in a Claude Code
session, not a shell.

**Codex CLI** has no plugin mechanism of its own for hooks, so `mehmory init --host codex`
(next step) writes the wiring directly — there is no separate marketplace step to run first.

### 2. Initialize the store

```bash
mehmory init                    # Claude Code (default)
mehmory init --host codex       # Codex CLI
```

Both are idempotent — running either twice changes nothing on disk.

**Claude Code default:** creates `~/.mehmory` (or `$MEHMORY_HOME` if you've set it), a
`.gitignore`, an empty `config.json`, and a git repo. Checks your Node version against the
plugin's requirement, and tells you whether the plugin is installed.

**`--host codex`:** does the same store setup, plus writes mehmory's hook entries into
`$CODEX_HOME/hooks.json` (`~/.codex` unless `$CODEX_HOME` is set), turns on Codex's
`[features] hooks` flag in `config.toml` if it's off, and installs the six skills under
`$CODEX_HOME/skills/mehmory-<name>/`. Both files are shared with other tools — mehmory only
ever adds or removes entries it can positively identify as its own, and backs each file up
before touching it. `mehmory init --host codex --uninstall` reverses all of it — the store
itself is untouched either way (see `docs/PRIVACY.md`). Full detail, including what survives
a hand-edited config: `docs/CLI.md`.

Expected: a summary of what was created (or confirmation that it already existed), plus a
line naming the next step — prefixed "in a Claude Code session, run …" for anything that's a
slash command, since `init` itself runs in a plain shell where those don't exist yet.

### 3. Onboard from existing transcripts

```bash
mehmory onboard
```

Scans `~/.claude/projects/*/` for past Claude Code sessions in the current project, distills
the recent ones into the inbox (capped by default at 30 sessions / 500 KB), redacts secrets,
and writes a one-line stub `project.md` so the store no longer looks empty. If you've never
had a Claude Code session in this project before, this is expected:

```
no transcripts found — run /mehmory:onboard-session inside a Claude Code session in your project instead
```

That's not a failure (exit 0) — it just means there's nothing to mine yet, and the in-session
`onboard-session` skill is the right tool for a genuinely new project. Want to see what would
be captured before writing anything: `mehmory onboard --dry-run`.

`onboard` reads only `~/.claude/projects/*/`, so it backfills from Claude Code history. There
is no Codex-transcript equivalent to mine — a Codex project starts from the deterministic hooks
capturing forward, same as `onboard-session` does for a Claude Code project with no transcript
history yet.

### 4. Your first session

Start `claude` (or `codex`) in your project as usual. `SessionStart` injects `identity.md` +
the stub `project.md` from onboarding + `index.md`, within an 800-token budget, on either
harness. Because onboarding just seeded a batch of inbox entries, you'll likely see a nudge
toward integrating:

Expected: the session starts normally, and somewhere early you'll see a note that the inbox
has entries waiting and that `/mehmory:integrate` will fold them into the wiki.

Run it:

```
/mehmory:integrate
```

This is model-driven, in-session work: the model reads the inbox and `SCHEMA.md`, decides
where each fact belongs, writes or edits pages, updates the index, and commits. **It writes to
`~/.mehmory`, which is outside your project directory — on Claude Code, this prompts you for
permission the first time.** This is expected. If you deny it, nothing is lost: the entries
simply stay in the inbox, capture keeps working through the deterministic hook layer, and the
next `/mehmory:integrate` (or the next SessionStart nudge) picks up right where you left off.
Denial is a safe, ordinary path here, not a broken one. (On Codex, whether the first hook
invocation prompts the same way is unverified — see `docs/TROUBLESHOOTING.md`'s note on Codex's
hook-trust mechanism.)

### 5. Your second session — this is where it knows your project

Start a new `claude` (or `codex`) session. **Now** `project.md` carries what the first
integrate actually wrote, not the onboarding stub — this is the session where "it already
knows my project" becomes true, not the first one.

### 6. Search and check on things anytime

```bash
mehmory search "what did we decide about auth"
mehmory status
mehmory doctor
```

`search` scans pages, archive, and the log across whichever scope you ask for — see
`docs/CLI.md` for exactly why it answers differently from the in-session pointer hook.
`doctor` runs a fixed health check list and prints copy-paste fixes for anything it flags.

## Configuration, errors, and privacy

- `docs/CONFIG.md` — every config group, its real default, and which keys are actually wired
  up versus present but currently inert, including the per-harness `hosts.claude-code.enabled`
  / `hosts.codex.enabled` toggle.
- `docs/TROUBLESHOOTING.md` — indexed by error code and the stable part of the message, with a
  Codex-specific section (`E_CODEX_INSTALL`, `E_CODEX_HARNESS_MISSING`,
  `E_CODEX_HOOKS_DISABLED`, `E_CODEX_HOOKS_UNWIRED`, `E_CODEX_SKILLS_MISSING`) alongside the
  Claude Code codes.
- `docs/PRIVACY.md` — the secret filter's real limits, what `purge` reaches and doesn't
  (redaction and purge reach both harnesses — there is one store, not one per harness), why
  mehmory never rewrites git history, and **uninstalling is not the same operation as deleting
  your data** on either harness — see that document for the full distinction and the
  export/restore procedure.
- `docs/UPGRADE.md` — what a `schema_version` drift warning from `doctor` means and what to do.
- `docs/CLI.md` — every command, including `mehmory init --host codex [--uninstall]`.

## License

MIT — see `LICENSE`.
