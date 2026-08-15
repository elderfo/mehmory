# CLI reference

`mehmory` is a single bundled binary (`dist/cli.mjs`, installed as `mehmory` via
`package.json`'s `bin`). It never talks to `~/.claude` for you and never edits your project —
it only reads and writes the store at `~/.mehmory` (or `$MEHMORY_HOME`, see `docs/CONFIG.md`).

## Conventions

- **Exit codes**, consistent across every command:

  | Code | Meaning |
  |---|---|
  | 0 | Success |
  | 1 | Usage error — unknown command/flag, wrong arity, ambiguous scope selector |
  | 2 | Store missing where the command requires one |
  | 3 | Operation failed — a write or git failure |
  | 4 | Aborted by the user — wrong purge confirmation token |

  `doctor` is the one exception: it additionally exits **5** (warnings only, no errors) and
  **6** (at least one error-level finding), and **never exits 2** — a missing store is itself
  the finding `doctor` exists to report, not a reason to fail differently from every other
  finding.

- **`--help`** (alias `-h`), **`<command> --help`**, and **`--version`** (alias `-v`) always
  exit 0.

- **`--json`.** Any invocation that includes `--json` anywhere in its arguments emits exactly
  one line on stdout and nothing else:

  ```json
  {"schema":1,"command":"<name>","ok":<bool>,"data":{...},"warnings":[...],"errors":[...]}
  ```

  `errors[]` elements are `{code, what, consequence, fix?}` — the same fields as a
  `MehmoryError` minus the `Details:` path, so a model reading the output gets the error code
  and the command's name without parsing prose. This includes usage errors: if `--json` was
  anywhere in argv, even a parse failure emits the envelope (`ok:false`, populated `errors[]`)
  on stdout and exits 1, rather than falling back to a plain-text usage message. Human-mode
  text goes to stdout for normal output and stderr for errors; JSON mode always writes to
  stdout only.

- **Scopes.** The four scope-taking commands — `onboard`, `search`, `stats`, and `purge` —
  share one grammar. `init`, `doctor`, and `status` take **no** scope flags: the first two act
  on the store as a whole, and `status` reports the current directory's scope, which is why it
  has nothing to select.
  - `--project [<key>]` — a specific project. The value is optional: with no value, the scope
    resolves from the current working directory's project key. A full key or a unique
    substring both match; an ambiguous substring exits 1 listing the candidate keys.
  - `--global` — the global scope (`identity.md`, `global/pages/`). Treated as first-class,
    not as "every project" — it is the most personal content in the store and must not
    require touching every project to reach.
  - `--agent [<name>]` — one agent scope (`agents/<name>/`). The value is optional: with no
    value, the scope resolves from `MEHMORY_AGENT`, falling back to `identity.agent` in
    `config.json`; bare `--agent` in a session with no agent name is a usage error. Unlike
    `--project`, the name must match **exactly** — there is no substring pass and
    `identity.aliases` is not consulted, because that table maps project keys. The flag is
    what separates the two namespaces: `--agent` only ever resolves against agent scopes and
    `--project` only ever against project keys, even when a name is a substring of a key.
    Agent scopes appear in output labelled `agent:<name>`.
  - `--all` — every scope.
  - A command that cannot act on a scope it was given (for example, a command with no
    per-project meaning) rejects it with exit 1 rather than silently ignoring the flag.

## Commands

### `mehmory init [--host <name>] [--uninstall]`

`--host` selects the harness to wire mehmory into: `claude-code` (the default) or `codex`.
`--uninstall` reverses the wiring, and requires a non-default `--host` — Claude Code installs
and removes mehmory through its own plugin system, so there is nothing there for `init` to
undo.

#### Default host

Idempotent. Calls the library's `initStore()`, which creates the store layout, `git init`s it,
and — when absent — writes `~/.mehmory/.gitignore` (containing `.state/`) and an **empty**
`config.json` (`{}`, not a fully-defaulted file — see `docs/CONFIG.md` for why). Also:

- Checks the running Node version against `package.json`'s `engines` field and warns if it is
  too old.
- Verifies the plugin is installed with a concrete filesystem probe, and prints the pinned
  install command if it is not found.
- Ends by naming the next step, prefixed for the shell reader: "in a Claude Code session,
  run `/mehmory:onboard-session`" (or the equivalent), since `init` runs in a plain shell
  where slash commands do nothing.

Running `init` twice changes nothing on disk.

#### Codex host

Codex has no plugin mechanism for hooks, so `init` writes the configuration itself — two
files under `$CODEX_HOME` (`~/.codex` unless the variable is set; see `docs/CONFIG.md`),
plus the six skills:

- **`hooks.json`** gets one entry per Codex lifecycle event mehmory captures:
  `SessionStart`, `UserPromptSubmit`, `Stop` and `PreCompact`. There is no `SessionEnd`
  entry, because Codex has no session-end event.
- **`config.toml`** gets `[features] hooks = true`, which Codex requires before any hook of
  any tool runs. Already on, and it is left exactly as it was.
- **`skills/`** gets one directory per skill — `mehmory-remember`, `mehmory-integrate`,
  `mehmory-lint`, `mehmory-onboard-session`, `mehmory-pause`, `mehmory-resume` — each holding
  a verbatim copy of the same `SKILL.md` Claude Code loads, the flat, prefix-named layout
  Codex itself uses (see `gstack-*` for the convention this follows). `mehmory doctor`'s
  `codex.skills` check looks for exactly this. `--uninstall` removes every `mehmory` /
  `mehmory-*` directory it finds and nothing else — a foreign skill directory under
  `skills/` is untouched by either direction.

Both `hooks.json` and `config.toml` are shared with every other tool that registers a Codex
hook, so both edits are merges, never rewrites:

- Entries mehmory did not write are never read, moved or removed — they survive install,
  re-install and uninstall unchanged.
- Mehmory's own entries are identified by a marker token on the command they run, not by
  the path of the script, so upgrading mehmory replaces the previous entry instead of
  leaving a stale duplicate. Re-running the install is idempotent: no duplicates, and a
  second run with nothing to change writes no bytes at all.
- Every file is copied to `<file>.mehmory.bak` immediately before it is modified. A run
  that changes nothing takes no backup.
- A `hooks.json` that does not parse is **refused**, not overwritten: exit **3** with
  `E_CODEX_INSTALL`, and the file is left byte-for-byte as it was. Overwriting a file
  mehmory could not read would silently unregister whoever else owns entries in it.
- The `config.toml` edit is a line edit. Your models, MCP servers, per-project trust levels
  and Codex's own hook-trust hashes are not reformatted around the one boolean that changes.
- **`hooks.json` byte-identity holds only under one assumption: the file was already in
  canonical 2-space JSON, the shape Codex itself writes.** Content correctness (no entry
  mehmory did not write is ever touched) holds unconditionally either way. But
  `hooks.json`'s edits re-serialize the whole document, so a hand-edited file in a different
  indent style comes back reformatted around a change that otherwise touched nothing of its
  own — see `docs/PRIVACY.md` for the user-facing version of this note.

Uninstall removes only mehmory's entries, prunes the events and groups that empty out as a
result, and **never turns the hooks feature back off** — the flag is Codex's, and other
tools' hooks depend on it.

Run `mehmory doctor` afterwards: it reports whether the wiring actually took (see below).

### `mehmory onboard [--project [<key>]|--global] [--dry-run] [--sessions N] [--max-bytes N] [--projects N] [--resume]`

Mines existing Claude Code transcripts under `~/.claude/projects/*/` to seed the inbox before
you've ever run a session with mehmory active — the cold-start path. Defaults: `--sessions 30`,
`--max-bytes` 500 KB, `--projects 50`.

- Each `~/.claude/projects/<encoded>` directory name is decoded back to a filesystem path,
  and the project key is resolved by running `resolveProjectKey()` **in that directory**. A
  directory whose decoded path no longer exists is listed `unresolvable` and skipped — never
  guessed.
- The project scan is capped at `--projects`; anything past the cap is listed as unscanned
  (the scan spawns `git` per uncached directory, so the cost is user-sized).
- Transcripts are distilled recent-first up to the session/byte caps, redacted, and appended
  via the inbox's append primitive, so replay by entry id is a no-op.
- A non-dry-run run also writes a one-line stub `project.md` into the target scope's
  directory. Under `--project` this is what stops the next `SessionStart` from reporting an
  empty store (see the README's note on why that matters). Under `--global` the file is
  written the same way but has **no** such effect: the empty-store check is keyed by project,
  so a global stub is inert.
- **Zero usable transcripts is not an error**: exit 0, printing "no transcripts found — run
  `/mehmory:onboard-session` inside a Claude Code session in your project instead."
- `--dry-run` writes nothing to the store — every byte of that guarantee is testable by
  hashing the store tree before and after.
- `--resume` continues an interrupted run using the same scope flags; it exits 1 if the
  recorded scope in the state file differs from the flags you passed. Reaching `done` deletes
  the state file.

### `mehmory search <query> [--project [<key>]|--global|--agent [<name>]|--all] [--limit N] [--json]`

Scans **pages, archive, and log** across the selected scopes and returns ranked hits as
`{path, scope, score, snippet, stale}`. `--limit` defaults to 10, capped at 100. The scan
itself is bounded by a file cap (default 2000 files); past the cap, the newest files are
scanned, a `warnings` entry says so, and the command still succeeds rather than failing.

**Demoted hits are ranked down, never hidden.** A page older than `decay.archive_days` is
scored ×0.7; anything under `archive/` is scored ×0.5, because archival is an explicit
"this aged out" act and a stronger signal than drifting past the horizon. Both come back
with `stale: true` and print a `[stale]` marker. `log.md` is never demoted — it records what
happened and cannot go out of date. Nothing is ever dropped for age: a stale answer still
beats no answer, and silent exclusion would hide a valid memory with no way to notice.

- Exit 0 with results.
- Exit 0 with an empty result set — a query that matches nothing is not an error.
- Exit 2 if the store is missing.

**Why `search` and the in-session pointer hook answer differently:** `search` scans pages,
archive, *and* `log.md`, because a human or a model asking an explicit question wants the
whole corpus; the `UserPromptSubmit` hook that offers pointers mid-session keeps the older,
narrower single-directory scan over the current scope's live pages (`matchPages`), because
that path runs on every prompt and has to stay cheap, not because it uses a different
retrieval method by design.

### `mehmory doctor [--json]`

Runs a fixed list of checks, each rated `ok | warn | error`:

- Node version against `engines`.
- Store directories present.
- Git health: `.gitignore` present, working tree clean, last commit.
- Plugin hooks registered.
- Per-hook `enabled` config state — warns, naming the config key, whenever a hook is
  disabled.
- Hook liveness, from `stats.jsonl`.
- Inbox entry count and age.
- Last integrate, from `log.md`.
- `errors.log` tail.
- `schema_version` drift (see `docs/UPGRADE.md`).
- Config parseability.
- KPI budget violations against the amended numbers in the spec's KPI table.
- The Codex surface, four checks, each carrying a real error code documented in
  `docs/TROUBLESHOOTING.md` rather than the generated `E_DOCTOR_<CHECK>` shape:

  | Check | Code | What it means |
  |---|---|---|
  | `codex.harness` | `E_CODEX_HARNESS_MISSING` | mehmory's entries are in `$CODEX_HOME/hooks.json` but Codex has no configuration there, so they run nothing |
  | `codex.hooks_flag` | `E_CODEX_HOOKS_DISABLED` | Codex's `[features] hooks` is off or unset, so no hook fires at all |
  | `codex.hooks` | `E_CODEX_HOOKS_UNWIRED` | one or more Codex events carry no mehmory entry, so those events capture nothing |
  | `codex.skills` | `E_CODEX_SKILLS_MISSING` | the mehmory skills are not installed for Codex, so nothing integrates what it captures (a warning — capture still runs) |

  All four are **silent** when neither Codex nor a mehmory Codex install is on the machine:
  a Claude-Code-only user gets no findings about a harness they don't run. They appear as
  soon as either `$CODEX_HOME/config.toml` or a mehmory entry in `$CODEX_HOME/hooks.json`
  exists.

Every finding with a real remedy carries a copy-paste command. Exit 0 (all `ok`), 5 (only
`warn` findings), or 6 (at least one `error` finding). `doctor` never exits 2 — an absent
store is itself one of the findings it reports, with `mehmory init` as the named remedy.

### `mehmory status [--json]`

A one-screen summary for the resolved scope: scope name and resolved key, page count, index
line count **and how many of those lines are demoted below the `## Archive` divider**, the
count of pages moved out to `archive/`, inbox entry count and age of the oldest entry, last
integrate, last commit, and any pending warnings. The two decay counts are here so aging is
visible without reading `index.md` by hand — a growing `demoted` number is the cue that
pages are falling off the front of the wiki. Warnings are read via `peekWarnings()` — non-destructively. Running
`status` does not consume the warning channel that the next `SessionStart` also reads; run it
as many times as you like without losing that signal.

### `mehmory stats [--project [<key>]|--global|--agent [<name>]|--all] [--since <iso>] [--json]`

Aggregates only fields that actually exist in `stats.jsonl`: per-hook invocation counts,
`ms` p50/p95, injection token p50/p95, pointers offered, and captured entries — plus inbox
age (from `inbox.md`'s mtime) and integrate cadence (from `log.md`). Nothing is synthesized
for a metric the store doesn't record.

`--agent` is accepted by the parser and rejected by the command with exit 1, exactly as
`--global` is: every record in `stats.jsonl` carries a project key, so an agent scope has
nothing to aggregate. `--all` still aggregates project records only; agent scopes enter the
report solely through the directory-derived figures (inbox age, integrate cadence).

Also broken down **per harness** (issue #14 story 39): every `stats.jsonl` record carries
`host`, so the report includes an invocation count and a captured-entry count for each
harness seen — `claude-code`, `codex`, or both, whichever actually wrote records in the
selected scope. Text output adds one indented line per harness under `captured`; `--json`
carries the same data as `data.hosts: [{host, count, capturedEntries}]`.

### `mehmory purge <page-slug> | --session <id> | --project [<key>] | --global | --agent [<name>] | --all`

`[--dry-run] [--export <path>] [--yes]`

Deletes. Preview-first, then a typed confirmation token **scaled to the blast radius**:

| Form | Token you must type |
|---|---|
| `--all` | the literal `DELETE ALL` |
| `--project [<key>]` | the **resolved** project key (never the substring you typed) |
| `--session <id>` | the last 8 characters of the session id, as shown in the preview |
| `--global` | `global` |
| `--agent [<name>]` | the **resolved** agent name (never the empty string a bare `--agent` types) |
| a page slug | the page's slug |

**Confirmation is two invocations, not an interactive prompt.** The first run prints the
preview and the required token and exits **4**, having touched nothing. You then re-run the
same command with the token on stdin:

```bash
mehmory purge --all                              # preview + token + exit 4, nothing deleted
printf '%s\n' 'DELETE ALL' | mehmory purge --all # deletes
```

This is deliberate, not a missing prompt: a command body never writes to stdout in this CLI
(the framework owns every byte), so a single invocation cannot print a preview and *then*
block for an answer. Exit 4 carries the code `E_ABORTED` and, in its `fix`, the exact piped
command to re-run. `--yes` skips both invocations and deletes immediately.

- A bare page slug that resolves in more than one scope exits 1, listing the candidates —
  it never deletes from both. The error's `fix` is the disambiguated command:
  `mehmory purge <slug> --project <key>` (or `--global`, or `--agent <name>` for a page in
  an agent scope). Passing a scope beside a slug is a *qualifier*, not a second target.
- A wrong token — or no token at all, which includes running the command on a terminal with
  nothing piped in — exits 4 and changes nothing.
- `--export <path>` copies the targets before deleting; if the export fails, the command
  aborts with exit 3 and deletes nothing.
- Purge deletes from the working tree, then commits. **If the commit fails, the files are
  already gone** — that is a terminal state, exit 3, naming the dirty store and
  `git -C ~/.mehmory commit -a` as the remedy.
- `mehmory purge` **never rewrites git history.** The command's own output states this and
  prints the `git filter-repo` recipe for anyone who wants the content gone from history too
  — see `docs/PRIVACY.md`.
- `--session <id>` is scoped to **un-integrated inbox entries only** — the only place a
  session id survives in the store (`src=<sessionId>` in the inbox's per-entry trailer). Once
  an entry has been integrated into a page, the session id that produced it is gone; purging
  a session cannot reach content that already made it into a page. This is stated here, in
  the command's own `--help` text, and in `docs/PRIVACY.md`.
- Within that limit, `--session` reaches **every inbox in the store**, not just the scope you
  would otherwise be in. Session ids are unique, and a session that touched two projects is
  exactly the case where a scoped purge would silently leave a copy behind. Agent scopes are
  not among those inboxes and are left untouched: capture always writes the *project* inbox,
  so an agent scope has none.
- `--agent <name>` deletes `agents/<name>/` **and sweeps every project inbox for
  un-integrated entries stamped `agent=<name>`**. Removing the directory alone would not
  delete the agent: the next integration would route those surviving entries straight back
  into a fresh scope. Other agents, projects, and `global/` are untouched.
- `--all` removes `agents/` alongside `global/` and `projects/`.

### `mehmory inbox-tx <append|snapshot|clear> [--json]`

The transactional inbox helper (A15), reachable through the CLI so a skill can call the
`mehmory` binary directly instead of resolving a path through a Claude-Code-specific
plugin-root variable. Same helper, same transactional guarantees, one more entry point
(A17) — `hooks/inbox-tx.mjs`, the bundled script skills previously shelled out to, and
this command both call the same `runInboxTx` implementation in `src/core/inbox-tx.ts`,
so neither is a second implementation of the other.

Input contract is unchanged: the subcommand is the first argument, and a JSON object goes
on **stdin**, not through flags — this is the one command whose payload isn't argv, because
the payload (entry text, a project key, a snapshot id) doesn't belong on a command line a
shell history might keep.

```bash
echo '{"inbox":"<path>/inbox.md","key":"<project key>","entries":[{"text":"...","src":"..."}]}' \
  | mehmory inbox-tx append     # -> {"appended":n,"skipped":m}
echo '{"inbox":"<path>/inbox.md","key":"<project key>"}' \
  | mehmory inbox-tx snapshot   # -> {"snapshotId":"...","entries":[...]}
echo '{"inbox":"<path>/inbox.md","key":"<project key>","snapshotId":"<id>"}' \
  | mehmory inbox-tx clear      # -> {"removed":n}
```

Without `--json`, stdout is exactly the result object above on one line — identical to
`hooks/inbox-tx.mjs`'s own stdout, so either entry point is a drop-in replacement for the
other. With `--json`, the result is wrapped in the standard envelope as `data`.

- Bad or missing input (unparseable stdin, a missing field, an unknown subcommand, a
  malformed or already-cleared `snapshotId`) is a usage error: exit **1**, code `E_USAGE`.
  This departs from `hooks/inbox-tx.mjs`'s own convention (a bare `inbox-tx: <message>`
  line on stderr, no code) — the CLI reports the same failures through its own envelope
  and exit-code conventions instead.
- This is the one command that never checks `storeExists()` first: the caller supplies the
  inbox path directly, and a skill snapshotting or clearing an inbox that doesn't exist yet
  is exactly the case `readInboxEntries` already treats as "no entries", not an error.
