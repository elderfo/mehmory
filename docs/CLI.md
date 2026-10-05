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
  | 2 | Store missing where required |
  | 3 | Operation failed — a write or git failure |
  | 4 | Aborted by the user — wrong purge confirmation token |

  `doctor` additionally exits **5** (warnings only, no errors) and
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
  on stdout and exits 1, rather than falling back to a
  plain-text usage message. Human-mode text goes to stdout for normal output and stderr for errors; JSON mode always writes to
  stdout only.

- **Scopes.** The four scope-taking commands — `onboard`, `search`, `stats`, and `purge` —
  share one grammar. `init`, `doctor`, and `status` take **no** scope flags: the first two act
  on the store as a whole, and `status` reports the current directory's scope, which is why it
  has nothing to select.
  - `--project [<key>]` — a specific project. The value is optional: with no value, the scope
    resolves from the current working directory's project key. A full key or a unique
    substring both match; an ambiguous substring exits 1 listing the candidate keys.
  - `--global` — the whole global scope (`global/`, including identity, index, inbox, log,
    pages and archive). Treated as first-class,
    not as "every project" — it is the most personal content in the store and must not
    require touching every project to reach.
  - `--all` — every scope.
  - A command that cannot act on a scope it was given (for example, a command with no
    per-project meaning) rejects it with exit 1 rather than silently ignoring the flag.

## Commands

### `mehmory init [--host <name>] [--uninstall]`

`--host` selects the harness to wire mehmory into: `claude-code` (the default), `codex` or
`pi`. `--uninstall` reverses the wiring, and only `--host codex` has any — Claude Code and Pi
install and remove mehmory through their own plugin and package systems, so there is nothing
there for `init` to undo. On either of those, `--uninstall` exits 1 with `E_USAGE` and names
the harness's own removal command as the fix.

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
plus the six skills. A successful install also calls `initStore()` for the same store layout
and git setup as the default host; `--uninstall` never initializes or writes to the store.
Both directions serialize through `.mehmory-install.lock` under `$CODEX_HOME`.
Missing built hook bundles cause `E_CODEX_INSTALL` before any configuration or store writes.

The Codex wiring is:

- **`hooks.json`** gets one entry per Codex lifecycle event mehmory captures:
  `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact` and `SessionEnd`. Earlier
  versions skipped `SessionEnd`, because Codex had no session-end event when the
  integration was written; Codex 0.153.4 fires it with the same payload Claude Code
  sends.
- **`config.toml`** gets `[features] hooks = true`, which Codex requires before any hook of
  any tool runs. Already on, and it is left exactly as it was.

Writing those files is not the last step. Codex will not run a hook until you have
approved it, so a fresh install captures nothing until you start `codex` once and accept
the hook review it shows you. `mehmory doctor`'s `codex.hooks_trust` check is what tells
you the review is still outstanding. For already-approved hooks, `init` mentions possible
re-approval only when it actually changed the hook entries.

- **`skills/`** gets one directory per skill — `mehmory-remember`, `mehmory-integrate`,
  `mehmory-lint`, `mehmory-onboard-session`, `mehmory-pause`, `mehmory-resume` — each holding
  a verbatim copy of the same `SKILL.md` Claude Code loads, the flat, prefix-named layout
  Codex itself uses (see `gstack-*` for the convention this follows). `mehmory doctor`'s
  `codex.skills` check looks for exactly this. `--uninstall` removes every `mehmory` /
  `mehmory-*` directory it finds and nothing else — a foreign skill directory under
  `skills/` is untouched by either direction. Symlinked `$CODEX_HOME` and its ancestors are
  supported; symlink components inside its `skills/` tree on paths mehmory writes or removes
  are refused with `E_CODEX_INSTALL`.

Both `hooks.json` and `config.toml` are shared with every other tool that registers a Codex
hook, so both edits are merges, never rewrites:

- Entries mehmory did not write are never read, moved or removed — they survive install,
  re-install and uninstall unchanged.
- Mehmory's own entries are identified by a marker token on the command they run, not by
  the path of the script, so upgrading mehmory replaces the previous entry instead of
  leaving a stale duplicate. Re-running the install is idempotent: no duplicates, and a
  second run with nothing to change writes no bytes at all.
- Each configuration file is copied to `<file>.mehmory.bak` immediately before it is
  modified, replacing any previous backup with that immediately preceding state. Backups
  have mode `0600`. A run that changes nothing takes no backup. Symlinked `config.toml`
  and `hooks.json` are resolved with realpath: edits update the real target without replacing
  the symlink, and the backup is written next to that target (including outside `$CODEX_HOME`,
  for example into a dotfiles repository).
  A dangling or unresolvable configuration symlink is refused, not replaced.
- A `hooks.json` that does not parse is **refused**, not overwritten: exit **3** with
  `E_CODEX_INSTALL`, and the file is left byte-for-byte as it was. Overwriting a file
  mehmory could not read would silently unregister whoever else owns entries in it.
- The `config.toml` edit is a line edit. `[features]` headers accept whitespace and trailing
  comments; existing `hooks` comments survive. Root-level `features.*` dotted keys and
  single-line inline tables of boolean feature flags are updated in place, without adding
  another table. New dotted keys go after the entire preceding feature statement, including
  multiline arrays. Multiline basic (`"""`) and literal (`'''`) strings are preserved;
  their content and array continuation rows are never interpreted as headers or keys.
  Unsupported feature shapes (including `[[features]]`) or unsafe TOML such as an
  unterminated string are refused with a specific reason and `E_CODEX_INSTALL` before any
  Codex file or backup is written. `doctor` reports that the hooks feature **could not be
  determined** at warn level when unreadable or unsupported; a readable but absent flag
  is **unset** at error level. A parsed `true` flag is on even with unrelated multiline strings.
  Existing CRLF line endings are retained, including for appended configuration lines.
  Your models, MCP servers, per-project trust levels and Codex's own hook-trust hashes are not reformatted around the one boolean that changes.
- A semantic no-op leaves `hooks.json` byte-identical in any formatting, with no backup;
  uninstall on a foreign-only file reports **nothing to remove**. Edits that actually change
  entries re-serialize the document as canonical 2-space JSON, the shape Codex itself writes.
  Thus an install → uninstall round trip is byte-identical only when the original file was
  already canonical; foreign entries survive either way — see `docs/PRIVACY.md`.

Uninstall removes only mehmory's entries, prunes the events and groups that empty out as a
result, and **never turns the hooks feature back off** — the flag is Codex's, and other
tools' hooks depend on it. Skill directories are staged outside `skills/` first and restored
if staging or the hook edit fails. If deleting staged directories fails after the hook edit,
the integration stays fully uninstalled (no live hooks or discoverable skills); exit 3 with
`E_CODEX_INSTALL` names the leftover `$CODEX_HOME/.mehmory-uninstall-*` directory to clean up.

Skill sources, the skills-root symlink check, and every skill target are preflighted before
configuration edits, so a refusal creates no Codex configuration backups or partial skills.
Uninstall with neither a hook registry nor mehmory skills reports “nothing to remove” and
creates no files or `$CODEX_HOME` directory. Removing skills alone never creates `hooks.json`.
An unwritable installation lock is reported immediately; actual contention names
`$CODEX_HOME/.mehmory-install.lock` so a confirmed stale lock can be removed by hand.

Run `mehmory doctor` afterwards: it reports whether the wiring actually took (see below).

#### Pi host

Pi installs mehmory as a Pi package (`pi install git:github.com/elderfo/mehmory`), and the
package manifest in `package.json` gives Pi both halves: the extension
`hooks/pi-extension.mjs` and the `skills/` directory. So `init --host pi` writes nothing into
Pi's configuration. It creates the store exactly as the default host does, checks the Node
version, and ends by naming that `pi install` command, prefixed "in a shell". `--json` puts
the command in `data.next`.

The extension spawns the same five hook bundles every other harness runs, with `node` from
`PATH` (see `docs/WORLD_MODEL.md` A29). Skills are invoked as `/skill:<name>`, and every
line mehmory prints inside a Pi session names them that way. `onboard` does not read Pi
sessions; a Pi project starts from the hooks capturing forward.

### `mehmory onboard [--project [<key>]|--global] [--dry-run] [--sessions N] [--max-bytes N] [--projects N] [--resume]`

Mines existing Claude Code transcripts under `~/.claude/projects/*/` to seed the inbox before
you've ever run a session with mehmory active — the cold-start path. Defaults: `--sessions 30`,
`--max-bytes` 500 KB, `--projects 50`. `--max-bytes` must be at least 1; zero is a usage
error (exit 1), not a resumable byte-capped run.

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
- `--resume` continues an interrupted or byte-capped run using the same scope flags; it exits
  1 if the recorded scope differs from the flags you passed. The byte cap resets for each
  invocation, and completed sessions are skipped, so `mehmory onboard --resume` reaches older
  sessions instead of repeating the newest batch. Reaching `done` deletes the state file;
  stopping at the byte cap or on an append failure preserves it.
- An append failure returns **exit 3**, `E_APPEND_FAILED`, and the partial appended count.
  Wait for a busy store to become available, or repair the named inbox path, permissions or
  disk-space problem, then use the printed `mehmory onboard --resume` command. The failed
  session is retried, with entry-id deduplication preserving any entries that were
  successfully appended before the failure.

### `mehmory search <query> [--project [<key>]|--global|--all] [--limit N] [--json]`

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
- The Codex surface, four checks, whose error findings carry real error codes documented in
  `docs/TROUBLESHOOTING.md` rather than the generated `E_DOCTOR_<CHECK>` shape:
  an indeterminate hooks flag is a warning without `E_CODEX_HOOKS_DISABLED`.

  | Check              | Code                      | What it means                                                                                                                   |
  | ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
  | `codex.harness`    | `E_CODEX_HARNESS_MISSING` | mehmory's entries are in `$CODEX_HOME/hooks.json` but Codex has no configuration there, so they run nothing                     |
  | `codex.hooks_flag` | `E_CODEX_HOOKS_DISABLED`  | Error when Codex's `[features] hooks` is off or unset; warn without this code when the flag could not be determined; ok when on |
  | `codex.hooks`      | `E_CODEX_HOOKS_UNWIRED`   | one or more Codex events carry no mehmory entry, so those events capture nothing                                                |
  | `codex.skills`     | `E_CODEX_SKILLS_MISSING`  | the mehmory skills are not installed for Codex, so nothing integrates what it captures (a warning — capture still runs)         |

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

### `mehmory stats [--project [<key>]|--global|--all] [--since <iso>] [--json]`

Aggregates only fields that actually exist in `stats.jsonl`: per-hook invocation counts,
`ms` p50/p95, injection token p50/p95, pointers offered, and captured entries — plus inbox
age (from `inbox.md`'s mtime) and integrate cadence (from `log.md`). Nothing is synthesized
for a metric the store doesn't record.

Also broken down **per harness** (issue #14 story 39): every `stats.jsonl` record carries
`host`, so the report includes an invocation count and a captured-entry count for each
harness seen — `claude-code`, `codex`, or both, whichever actually wrote records in the
selected scope. Text output adds one indented line per harness under `captured`; `--json`
carries the same data as `data.hosts: [{host, count, capturedEntries, suppressed}]`.

`suppressed` counts invocations that skipped their body, by reason: `host_disabled`
(`hosts.<host>.enabled` is `false`) or `active_host` (`MEHMORY_ACTIVE_HOST` names another
harness, or `none`). A skipped hook still reads stdin to resolve the session's project key, so
plain `mehmory stats` in that project counts it. The text line appends `N suppressed (<reason>)`.

### `mehmory purge <page-slug> [--agent <name>] | --session <id> | --project [<key>] | --global | --all`

`[--dry-run] [--export <path>] [--yes]`

Deletes. Preview-first, then a typed confirmation token **scaled to the blast radius**:

| Form                | Token you must type                                              |
| ------------------- | ---------------------------------------------------------------- |
| `--all`             | the literal `DELETE ALL`                                         |
| `--project [<key>]` | the **resolved** project key (never the substring you typed)     |
| `--session <id>`    | the last 8 characters of the session id, as shown in the preview |
| `--global`          | `global`                                                         |
| a page slug         | the page's slug                                                  |

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
  `mehmory purge <slug> --project <key>`, `mehmory purge <slug> --global`, or
  `mehmory purge <slug> --agent <name>`, according to the scope kind. Passing a scope beside
  a slug is a *qualifier*, not a second target. `--agent` requires a page slug and a safe
  single-segment agent name; it cannot be combined with another scope or purge form.
  Project keys and agent names remain distinct even when their display labels collide.
- Page purges remove all live (`pages/`) and archived (`archive/`) copies of that slug in
  the selected scope, including an agent scope selected by `--agent` or an unambiguous slug.
  Only matching normative `- [[slug]] — summary` catalog lines are removed from that scope's
  `index.md`; freeform references and lines without the summary separator stay. Deleted
  summaries are no longer injected at SessionStart. Both file paths and the exact index
  lines appear in text and JSON dry-run previews. `--export` saves the selected index lines
  alongside the page copies, not the whole index.
- `--global` removes the **entire `global/` directory**, including identity, index, inbox,
  log, pages and archive; projects and agents stay. No global skeleton survives the purge.
  `mehmory init` (or the next SessionStart) may recreate empty template files. Until then,
  commands requiring the store's identity file report a missing store; run `mehmory init`.
- `--session <id>` requires **at least 8 characters and no whitespace**. Empty and shorter
  values are usage errors (**exit 1**, `E_USAGE`), even with `--yes` or `--dry-run`.
- A wrong token — or no token at all, which includes running the command on a terminal with
  nothing piped in — exits 4 and changes nothing.
- Purge validates every file, directory and index target before any export or mutation.
  Unsafe targets, including symlinks escaping the store, abort with exit 3: nothing is
  deleted and catalog lines stay intact. A symlink nested inside a whole-scope target is
  found during `--export`, so files copied before it may remain in the export directory;
  nothing from outside the store is copied.
- `--export <path>` copies the targets before deleting and checks each source, including
  nested files, for store containment. If the export fails, the command aborts with exit 3
  and deletes nothing.
- A failure while clearing multiple inboxes returns exit 3 and reports how many selected
  entries were deleted and how many remain. Earlier clears are not rolled back, and no purge
  commit was made: inspect `git -C <store> status` before retrying the remaining deletion.
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
  exactly the case where a scoped purge would silently leave a copy behind.

### `mehmory inbox-tx <append|snapshot|clear|pause|resume> [--json]`

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
echo '{"session_id":"<current harness session id>"}' \
  | mehmory inbox-tx pause      # -> {"session_id":"...","paused":true}
echo '{"session_id":"<current harness session id>"}' \
  | mehmory inbox-tx resume     # -> {"session_id":"...","paused":false}
```

`pause` and `resume` require an explicit, existing live `session_id`, not an inbox path
or project key. They change only the pause flag under the session lock and preserve the
cursor, Stop counter, topic cache, and origin. Use a reliably identified harness session
id from the `session: <id>` line inside the injected `<mehmory-memory>` frame; selecting
the newest state file is unsafe with concurrent sessions. State filenames are SHA-256 hashes
of ids, not the ids themselves. These operations never edit config or re-enable hooks disabled
there. Busy sessions fail without changing state. A finalized session resumes from its saved
cursor only after SessionStart or evidence of later transcript activity; otherwise it reports
`session is busy or finalized; retry after the next turn`, not an unknown id.

Without `--json`, stdout is exactly the result object above on one line — identical to
`hooks/inbox-tx.mjs`'s own stdout, so either entry point is a drop-in replacement for the
other. With `--json`, the result is wrapped in the standard envelope as `data`.

- Bad or missing input (unparseable stdin, a missing field, an unknown subcommand, a
  malformed or already-cleared `snapshotId`), failed appends, and busy or unavailable
  session state are usage errors: exit **1**, code `E_USAGE`. An append failure reports
  stderr and no success object; retry the same entries (already-written ids are deduped).
  This departs from `hooks/inbox-tx.mjs`'s own convention (a bare `inbox-tx: <message>`
  line on stderr, no code) — the CLI reports the same failures through its own envelope
  and exit-code conventions instead.
- This is the one command that never checks `storeExists()` first: the caller supplies the
  inbox path directly, and a skill snapshotting or clearing an inbox that doesn't exist yet
  is exactly the case `readInboxEntries` already treats as "no entries", not an error.
