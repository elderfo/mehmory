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

Every code below is checked against the codebase's `ERROR_KINDS` registry. `actionable` codes
always carry a `Fix:` clause with a runnable command; `informational` codes never invent one.

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
