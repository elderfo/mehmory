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

- **`--help`**, **`<command> --help`**, and **`--version`** always exit 0.

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

- **Scopes.** `init`, `doctor`, `stats`, `search`, and `purge` share one scope grammar where
  it applies to them:
  - `--project [<key>]` — a specific project. The value is optional: with no value, the scope
    resolves from the current working directory's project key. A full key or a unique
    substring both match; an ambiguous substring exits 1 listing the candidate keys.
  - `--global` — the global scope (`identity.md`, `global/pages/`). Treated as first-class,
    not as "every project" — it is the most personal content in the store and must not
    require touching every project to reach.
  - `--all` — every scope.
  - A command that cannot act on a scope it was given (for example, a command with no
    per-project meaning) rejects it with exit 1 rather than silently ignoring the flag.

## Commands

### `mehmory init`

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
- A non-dry-run run also writes a one-line stub `project.md` for the target scope, so the
  store no longer looks unpopulated to the next `SessionStart` hook (see the README's note on
  why this matters).
- **Zero usable transcripts is not an error**: exit 0, printing "no transcripts found — run
  `/mehmory:onboard-session` inside a Claude Code session in your project instead."
- `--dry-run` writes nothing to the store — every byte of that guarantee is testable by
  hashing the store tree before and after.
- `--resume` continues an interrupted run using the same scope flags; it exits 1 if the
  recorded scope in the state file differs from the flags you passed. Reaching `done` deletes
  the state file.

### `mehmory search <query> [--project [<key>]|--global|--all] [--limit N] [--json]`

Scans **pages, archive, and log** across the selected scopes and returns ranked hits as
`{path, scope, score, snippet}`. `--limit` defaults to 10, capped at 100. The scan itself is
bounded by a file cap (default 2000 files); past the cap, the newest files are scanned, a
`warnings` entry says so, and the command still succeeds rather than failing.

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

Every finding with a real remedy carries a copy-paste command. Exit 0 (all `ok`), 5 (only
`warn` findings), or 6 (at least one `error` finding). `doctor` never exits 2 — an absent
store is itself one of the findings it reports, with `mehmory init` as the named remedy.

### `mehmory status [--json]`

A one-screen summary for the resolved scope: scope name and resolved key, page count, index
line count, inbox entry count and age of the oldest entry, last integrate, last commit, and
any pending warnings. Warnings are read via `peekWarnings()` — non-destructively. Running
`status` does not consume the warning channel that the next `SessionStart` also reads; run it
as many times as you like without losing that signal.

### `mehmory stats [--project [<key>]|--global|--all] [--since <iso>] [--json]`

Aggregates only fields that actually exist in `stats.jsonl`: per-hook invocation counts,
`ms` p50/p95, injection token p50/p95, pointers offered, and captured entries — plus inbox
age (from `inbox.md`'s mtime) and integrate cadence (from `log.md`). Nothing is synthesized
for a metric the store doesn't record.

### `mehmory purge <page-slug> | --session <id> | --project [<key>] | --global | --all`

`[--dry-run] [--export <path>] [--yes]`

Deletes. Preview-first, then a typed confirmation token **scaled to the blast radius**:

| Form | Token you must type |
|---|---|
| `--all` | the literal `DELETE ALL` |
| `--project [<key>]` | the **resolved** project key (never the substring you typed) |
| `--session <id>` | the last 8 characters of the session id, as shown in the preview |
| `--global` | `global` |
| a page slug | the page's slug |

- A bare page slug that resolves in more than one scope exits 1, listing the candidates —
  it never deletes from both.
- The wrong token exits 4 and changes nothing. `--yes` skips the prompt.
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
