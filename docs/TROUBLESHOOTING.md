# Troubleshooting

Every error mehmory surfaces follows one template:

```
MEHMORY E_<CODE>: <what>. <consequence>. [Fix: <command>. ]Details: <errors.log path>
```

**This index is built on the `E_<CODE>` prefix and the `<consequence>` sentence — not on
the full message.** The `<what>` segment is runtime-variable: it's often a raw Node/V8 error
string (a JSON parse error, an `fs` errno, a git stderr line), and it differs by machine, by
input, and sometimes by Node version. Grepping for it will not find this doc. Search this page
for the `E_` code and the (fixed) `<consequence>` text instead — for example, a real message
reads:

```
MEHMORY E_CONFIG_PARSE: Unexpected token } in JSON at position 42. Memory is running on
defaults, so your settings are not applied. Fix: $EDITOR /home/u/.mehmory/config.json.
Details: /home/u/.mehmory/.state/errors.log
```

— `Unexpected token } in JSON at position 42` is the variable part; `Memory is running on
defaults, so your settings are not applied` is stable and indexed below. `Details:` always
points at `$MEHMORY_HOME/.state/errors.log` (`~/.mehmory/.state/errors.log` unless you've set
`MEHMORY_HOME` — see `docs/CONFIG.md`).

Every `##` code below is checked against the codebase's `ERROR_KINDS` registry — a test fails
the build if this page and the registry disagree in either direction. `actionable` codes always
carry a `Fix:` clause with a runnable command; `informational` codes never invent one.

The CLI adds a few codes of its own that are deliberately **not** in that registry, because no
library function can raise them. They have their own section at the bottom of this page, and
they include the one you will hit most often.

## E_CONFIG_PARSE (actionable)

Two consequences, same code:

- **`config.json` itself is unparseable.**
  Consequence: *Memory is running on defaults, so your settings are not applied.*
  Fix: `$EDITOR <path to config.json>`.
- **A `secrets.patterns` entry in your config is not a usable regex.**
  Consequence: *That pattern is skipped; the built-in secret patterns still apply.*
  Fix: `$EDITOR <path to config.json>`.
  Your other settings still load; only the one bad pattern is dropped, and the hardcoded
  secret patterns keep working regardless.

## E_STORE_INIT (actionable or informational)

- **`git init` failed inside an otherwise-created store.**
  Consequence: *Store is initialized but git repository was not created.*
  Fix: `git -C <resolved store home> init`.
- **Anything else during store creation** (permissions, disk space, unexpected I/O error).
  Consequence: *The mehmory store could not be created or updated.*
  No `Fix:` — there's no single runnable command that's right for every cause; check the
  `<what>` text this once, since there's no other lead.

## E_APPEND_FAILED (informational)

A single-line append to the store (inbox, log, or stats) failed — usually permissions or
disk space. Consequence: *Record was not appended.* No `Fix:` clause; "check permissions and
disk space" is prose, not a command, so it's omitted rather than printed as if it were one.

The same code is also raised through `failOpen` by read-shaped operations that fall back
rather than append (the store summary behind `status` and `doctor`, for one). Those print
the generic *Operation failed; using fallback* consequence instead, so match on the
`MEHMORY E_APPEND_FAILED` prefix rather than on the sentence after it.

## E_ATOMIC_WRITE (informational in practice)

Covers a temp-file-plus-rename write that failed — building the injection frame, or a decay
pass rewriting `index.md`. Consequence: *Operation failed; using fallback.* The registry
marks this code `actionable`, but every current call site routes through the library's
fail-open wrapper, which always synthesizes an `informational` instance with no invented fix
(there's no single remedy for "a rewrite failed" that's right in general). No `Fix:` clause
in practice.

## E_TRANSCRIPT_PARSE (informational in practice)

A transcript JSONL file couldn't be read while distilling capture data. Consequence:
*Operation failed; using fallback.* Same fail-open path as `E_ATOMIC_WRITE`, above.

## E_LOCK_TIMEOUT (informational)

The project lock was held past the retry bound, and the operation proceeded without it.
Consequence: *A concurrent session may have overwritten an index rewrite.* No `Fix:` — this
is expected behavior under contention, not a fault.

## E_DISTILL_LOSSY (informational)

Some transcript lines were unparseable during a distill pass. Consequence: *Some session
content was not captured.* No `Fix:` — nothing to run; if this recurs, `mehmory doctor`'s
`errors.log` tail check will surface the pattern.

## E_GIT_COMMIT (informational)

A commit to the store's git repo failed — not in a repo, staging failed, or the commit
itself failed (often `index.lock` contention). Consequence is one of: *Commit failed; memory
was not recorded*, *Failed to stage paths; commit aborted*, or *Commit failed; tree left
staged for manual recovery*. No `Fix:` clause; `mehmory doctor` flags an uncommitted store so
you don't have to notice on your own.

## E_QUEUE_CLAIM (informational)

A durable job could not be enqueued. Consequence: *Job was not enqueued.* No `Fix:`.

## E_SESSION_STATE (informational)

Either a session's state file (`.state/<session-id>.json`) was corrupt or unreadable and got
reset, or a hook ran with no `session_id` at all. Consequence is one of: *Capture state reset
to fresh; the transcript may be re-distilled once*, or *The invocation was skipped; no session
state was read or written.* No `Fix:` — both are self-healing.

## E_CURSOR_RESET (informational)

Registered in the error registry; no code path in this run constructs it. If you see it,
that's itself worth reporting — treat the `<what>`/`<consequence>` text as the only lead,
since there's no known trigger to point at.

## E_SEARCH_FAILED (informational)

A `mehmory search` scan failed or was cut short partway through. No `Fix:` — nothing for the
user to run; re-running `search` is the implicit remedy.

## E_TRANSCRIPT_READ (informational)

`mehmory onboard` couldn't read one transcript file. That session is skipped; the rest of the
onboard run continues. No `Fix:`.

## E_TRANSCRIPT_DIR_UNRESOLVED (informational)

A `~/.claude/projects/<encoded>` directory decodes to a filesystem path that no longer
exists, so `onboard` can't resolve its project key. Listed as `unresolvable` and skipped —
never guessed. No `Fix:`; there's no correct guess to offer.

## E_PURGE_FAILED (actionable)

`mehmory purge` deleted the target files from the working tree but the commit failed — the
store is left dirty, with the files already gone. Consequence: *the store is left in a dirty,
uncommitted state.* Fix: `git -C <resolved store home> commit -a`. This is the one purge
failure mode with a real remedy: the delete already happened, so re-running `purge` is not
the fix — committing the pending removal is.

## E_CODEX_INSTALL (actionable)

`mehmory init --host codex` could not read or write a file under `$CODEX_HOME`. Consequence:
*the file was left exactly as it is, so no hook registration was changed.* Fix: `$EDITOR
<the named file>` when it does not parse, `ls -l <its directory>` when the write itself
failed.

The refusal is deliberate. `~/.codex/hooks.json` is shared with every other tool that
registers a Codex hook, so a file mehmory cannot parse is left alone rather than replaced —
overwriting it would silently unregister whoever else owns entries in it. Fix the JSON (or
move the file aside) and re-run the install.

## E_CODEX_HARNESS_MISSING (actionable)

`$CODEX_HOME/hooks.json` holds mehmory's hook entries, but there is no `config.toml` there —
Codex is not configured at that location. Consequence: *those entries run nothing.* Fix:
`mehmory init --host codex --uninstall`.

Usually means Codex was uninstalled, or `CODEX_HOME` now points somewhere else. If Codex is
still installed elsewhere, set `CODEX_HOME` to that directory and run the install there
instead of the uninstall above.

## E_CODEX_HOOKS_DISABLED (actionable)

Codex's `[features] hooks` flag is `false` or unset in `$CODEX_HOME/config.toml`.
Consequence: *no hook fires at all* — not mehmory's, and not any other tool's. Fix:
`mehmory init --host codex`, which turns the flag on without touching the rest of the file.

This is the first thing to check when Codex sessions capture nothing: the hooks can be
perfectly registered and still never run, because the flag gates all of them.

## E_CODEX_HOOKS_UNWIRED (actionable)

`$CODEX_HOME/hooks.json` carries no mehmory entry for one or more of the four Codex events
mehmory captures (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`) — or the file
does not parse, in which case nothing at all is registered. Consequence: *those events
capture and inject nothing under Codex.* Fix: `mehmory init --host codex`, or `$EDITOR
$CODEX_HOME/hooks.json` when `doctor` reports the file as unparseable.

`mehmory doctor` names the specific events that are missing, so a partial wiring — one hook
hand-deleted, or an install interrupted — reads as such rather than as "not installed".

## E_CODEX_SKILLS_MISSING (actionable)

No `mehmory` or `mehmory-*` skill directory under `$CODEX_HOME/skills/`. Consequence:
*nothing integrates what Codex captures* — the judgment-work commands (integrate, lint,
onboard) are unavailable there. Fix: `mehmory init --host codex`.

Reported as a **warning**, not an error: the hooks are what capture and inject, and they
keep working. What you will notice instead is the inbox filling up and never being merged
into the wiki.

## E_AGENT_NAME_INVALID (actionable)

`MEHMORY_AGENT`, or `identity.agent` in `config.json`, holds a value that cannot be a
directory name under `agents/`. Consequence: *this agent runs unnamed* — it captures and
recalls the project and global scopes exactly as before, but gets no agent scope of its own
and stamps no attribution on what it captures. Fix: set the name to 1-64 characters of
`[a-z0-9._-]`, not starting with a dot, and not one of `global`, `projects`, `agents`, `all`.

An invalid name is refused rather than rewritten, and does not fall back to the other source:
a hashed or substituted name would be unreadable, and silently adopting `config.identity.agent`
after rejecting `MEHMORY_AGENT` would file this agent's memory under a different identity than
the one it declared. Lowercase only, because `Scout` and `scout` would share one directory on a
case-insensitive filesystem.

## CLI-level codes (not in `ERROR_KINDS`)

These three shapes are raised by `src/cli/` and never by a library function, so they are
correctly absent from the registry above — a hook can't produce a usage error, and nothing in
`src/core/` knows what a confirmation prompt is. They use the same
`MEHMORY E_<CODE>: …` template and appear in the `--json` envelope's `errors[]` exactly like
registry codes.

### E_USAGE (actionable)

The command didn't run: an unknown command or flag, wrong arity, a flag missing its value, two
mutually exclusive forms at once, or a scope selector that matched more than one project.
Consequence: *The command did not run.* Fix: always a runnable command — usually
`mehmory <command> --help`, and for an ambiguous purge slug the disambiguated command itself
(`mehmory purge <slug> --project <key>`). Exit code **1**. This is the code you will see most
often, and it is the one a script should treat as "I called it wrong", never as "the store is
broken".

### E_ABORTED (actionable)

`mehmory purge` stopped before deleting anything, because the confirmation token on stdin was
absent or wrong. Consequence: *Nothing was deleted.* Fix: the exact piped re-run, with the
token filled in — `printf '%s\n' '<token>' | mehmory purge <the same arguments>`. Exit code
**4**. Seeing this on a first `purge` invocation is the designed path, not a failure: purge
confirmation is two invocations (see `docs/CLI.md` and `docs/PRIVACY.md`).

### E_DOCTOR_&lt;CHECK&gt; (informational or actionable)

`mehmory doctor --json` reports each failing finding as an envelope error whose code is
`E_DOCTOR_` plus the check name upper-cased with non-alphanumerics collapsed to `_` — so
`git.gitignore` becomes `E_DOCTOR_GIT_GITIGNORE`, `hooks.liveness` becomes
`E_DOCTOR_HOOKS_LIVENESS`, and so on. These are a machine-readable projection of the text
`doctor` already prints; the remedy is whatever that finding's `fix` names. They are generated
from the check list, which is why they are described as a shape here rather than enumerated —
`mehmory doctor` is the authoritative list, and `docs/CLI.md` documents the checks themselves.

## Not an error: the stop nudge never appears under `codex exec`

In an interactive Codex TUI session the Stop hook's once-per-threshold nudge renders as
`Stop hook (blocked) feedback: …`, the model answers it, and Stop re-fires with
`stop_hook_active: true` — the same loop-guard cycle as Claude Code.

Under `codex exec` (non-interactive) it does not. Codex accepts the block, but a non-interactive
run has no follow-up turn to put it in: the run simply ends. Measured against Codex CLI 0.146.0.

**Nothing is lost.** The nudge is the second of two layers. The first — distilling the session's
transcript delta into the inbox — is deterministic, needs nothing from the model, and runs before
the block is emitted, so a `codex exec` run captures exactly what an interactive one does. What
you do not get is the model volunteering the reasoning that never reached the transcript.

This is a property of non-interactive execution, not a bug, and mehmory does not work around it:
the alternatives (writing the nudge to stderr, blocking a run that cannot answer) would either
be noise or would hang the run. If you want the model's own account of a `codex exec` run, ask
for it in the prompt — `remember:` works there like anywhere else.

## Not an error: a Codex session is finalized by the *next* session, not by its own end

Codex has no session-end event. Claude Code fires `SessionEnd`, mehmory distills the last
stretch of the transcript there, and the next `SessionStart` writes it to the inbox. Under Codex
that first half never happens — nothing tells mehmory the session is over, including when the
session is over because the terminal was closed or the process was killed.

So finalization moves to the front of the next session instead. Every hook invocation records
which transcript the session is reading and which harness is reading it; a session whose state is
still on disk, has no finalization marker, and has sat untouched for 30 minutes is treated as
abandoned, and the next `SessionStart` in any project distills its remaining delta, files it,
logs one `session-end` line, commits, and marks it finalized. The marker is what makes this safe
to repeat: a session finalized once — by its own `SessionEnd` or by a previous session start —
is skipped, so nothing is written or committed twice. The 30-minute idle window is what keeps a
second terminal from retiring a session that is merely quiet.

**Nothing is lost, but it is late.** Material from a Codex session that ended abruptly appears in
the inbox when the next session starts, not when the session ended. If that session was the last
one of the day, the entries land tomorrow. `mehmory status` will show the inbox without them
until then. Starting any session — in any project — is enough to flush it.

## Unverified: whether Codex trusts a freshly written hook on first run

Codex's `config.toml` can carry `[hooks.state.<event>.<hash>] trusted_hash` entries — a
trust record keyed by the hash of the hook command Codex has previously seen and approved for
that event. A hook entry `mehmory init --host codex` writes is brand new, so it has no such
record.

**Whether Codex prompts for trust, or silently refuses to run an untrusted hook, on its first
invocation is unverified on Codex CLI 0.146.0.** This is not measurable without touching a
real user's `~/.codex` configuration and living through Codex's interactive trust flow (if any)
by hand — the same wall that stops the `PreCompact` payload from being measured, below. Do not
read this as "it works" or as "it doesn't": neither claim is made here.

**The one-command check, if you want to know for your own install:** run
`mehmory init --host codex`, then start a Codex session in a project and watch for mehmory's
routing block in the first turn's context. If it's there, the hook ran; if it's silently
absent and `mehmory doctor` still reports the wiring as `ok`, Codex most likely declined to run
an untrusted hook rather than mehmory failing — check `$CODEX_HOME/config.toml` for a
`trusted_hash` entry under the relevant event to tell the two apart.

### The `PreCompact` caveat

mehmory registers a `PreCompact` hook on Codex, and on Claude Code it does what it says: capture
everything since the last capture, just before the context is compacted.

On Codex CLI 0.146.0 that hook is **unverified**. The event exists in the binary, and there is
evidence it has fired on some machines, but no run in this project's measurement work ever
produced one — a `codex exec` run fires `SessionStart`, `UserPromptSubmit` and `Stop` and never
compacts. Its payload has therefore never been observed, so the hook assumes nothing about it: it
checks for a readable `transcript_path` (the one field every measured Codex event does carry) and,
on any payload it does not recognize, logs `E_TRANSCRIPT_PARSE` and does nothing at all rather
than acting on guessed field names.

The consequence is that on Codex, compaction is not a capture point you should count on. The
next-session-start path above is what the design relies on, and it does not depend on `PreCompact`
firing, on its payload, or on compaction happening at all. Deliberately, `PreCompact` also never
finalizes a session: a compaction is not an ending, and retiring the session there would leave
everything after the compaction with no route into the inbox.
