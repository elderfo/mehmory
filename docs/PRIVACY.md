# Privacy

mehmory stores everything as markdown in a git repository at `~/.mehmory` (or `$MEHMORY_HOME`,
see `docs/CONFIG.md`). You can read it, `grep` it, edit it, and inspect its history with
ordinary git tools at any time. This document covers what mehmory does to keep secrets out of
that store, what happens when you ask it to delete something, and what to do if you need
content gone from history too — those are three different questions with three different
answers.

## Not every turn you type is captured

Two filters run before anything reaches the inbox, and both discard silently — there is no
per-turn log of what was dropped.

The first removes blocks the harness wrote into a turn rather than you: slash-command
echoes, `!`-mode bash input and output, agent-completion notices, injected reminders. It is
anchored to the start of a line, so a turn that merely quotes one of those tag names while
discussing it keeps its text.

The second is a length floor. What remains after that stripping must be at least 8
characters, which drops bare answers like "yes", "agreed" and "Ship it". The floor is
deliberately low, and low enough not to assume your turn is written in a script that
separates words with spaces — a short sentence in Chinese, Japanese or Korean is kept.

Both are subtractive and neither writes anywhere, so a dropped turn leaves no trace in the
store — including a turn dropped because a harness block happened to contain a secret. The
transcript on disk is unaffected either way; `mehmory onboard` re-reads it, so a capture
missed today can be backfilled by a later version with a different floor.

## The secret filter's real limits

Every write to the store passes through `redact()`, which applies five built-in regex
patterns (AWS keys, GitHub tokens, bearer tokens, private-key blocks, `.env`-shaped
`KEY=value` lines) plus anything you add under `secrets.patterns` in `config.json`.

**Redaction reaches both harnesses.** There is one store and one `redact()` call on the write
path, regardless of whether the session that produced the text was Claude Code or Codex CLI —
harness identity is not a redaction input, so nothing about a Codex-originated capture is
filtered differently or filtered less.

**This is best-effort pattern matching, not a PII-safe guarantee.** It catches secrets that
look like the shapes above. It does not reliably catch:

- Personally identifiable information in prose (names, addresses, phone numbers written as
  sentences rather than key=value pairs).
- Secrets in formats the built-in patterns don't recognize (a custom internal token scheme,
  a credential embedded mid-sentence rather than on its own line).
- Anything a whitelist entry exempts — see the whitelist semantics below, which are
  deliberately conservative but still let through exactly what you told it to.

If something sensitive doesn't match one of the patterns above, it lands in the store
unredacted. Treat the filter as a safety net against the common accidental-paste case, not as
a reason to write things into a session you wouldn't want persisted.

### Whitelist semantics — read this before you rely on it

`secrets.whitelist` entries are literal substrings exempt from redaction. The rule is
precise: **a whitelist entry exempts a secret match only when the entry fully contains that
match.** A partial overlap between a whitelist entry and a matched secret still redacts the
secret — a whitelist entry can never make the built-in patterns catch *less* than they
otherwise would.

This matters because the first implementation of this filter had the rule backwards: it
treated any overlap as exempting the whole match, which meant a whitelist entry naming a short
fragment could silently let an entire AWS key through unredacted. That was caught during
verification and fixed with regression tests before this run shipped. If you're extending
`redact.ts`, do not "simplify" the containment check back to an overlap check — that
regression is exactly what it would reintroduce.

## What `purge` does and does not reach

`mehmory purge` (see `docs/CLI.md`) deletes from the working tree and commits the removal.

**Purge reaches content captured by either harness.** The store has no per-harness partition —
a page, an inbox entry, or a project is the same kind of thing whether a Claude Code session or
a Codex CLI session produced it, so every purge scope (`--page`, `--session`, `--project`,
`--global`, `--all`) reaches Codex-captured material exactly as it reaches Claude Code-captured
material, with no separate flag needed.

**Deleting anything takes two invocations.** The first run previews the targets, prints the
confirmation token scaled to what you're about to lose, and exits 4 having changed nothing;
the second run supplies that token on stdin
(`printf '%s\n' 'DELETE ALL' | mehmory purge --all`). `--yes` collapses the two into one when
you're scripting. There is no interactive `y/N` prompt anywhere in mehmory — a single
keystroke is not enough friction for `--all`, and the CLI's output contract does not allow a
command to print a preview and then block for an answer.

Four more things follow from working-tree deletion:

1. **It removes files, not history.** mehmory never rewrites your store's git history — see
   the recipe below for when you need that.
2. **`--session <id>` only reaches un-integrated inbox entries.** A session id survives in the
   store in exactly one place: the `src=<sessionId>` trailer on an inbox entry that hasn't
   been integrated into a page yet. Once `/mehmory:integrate` folds an entry into a wiki page,
   the session id that produced it is gone — the page just has a fact on it. Purging a
   session cannot reach content that already made it into a page; if you need that gone,
   purge the page itself.
   Within that limit it is deliberately **store-wide**: `--session` clears matching entries
   from *every* inbox, not only the project you happen to be standing in. Session ids are
   unique, so there is no false positive to fear, and a session that touched two projects is
   exactly the case where a scope-limited delete would leave a copy behind.
3. **`--global` is its own scope**, not "every project" — `identity.md` and `global/pages/`
   are the most personal content in the store, and purge lets you reach them without deleting
   every project's memory along with them.
4. **`--agent <name>` is its own scope** too, in the same sense — `agents/<name>/` holds what
   one agent is, not what one project is — and purge deletes it without touching `global/`,
   any integrated project page, or any other agent.

   **It reaches further than the directory, and further than self-facts.** Removing
   `agents/<name>/` alone would not delete the agent: an un-integrated entry stamped
   `agent=<name>` would be routed straight back into a fresh scope by the next integration,
   so purge sweeps those stamps out of every inbox. But the stamp records *which agent was
   running* when an entry was captured, not what the entry is about — every capture a named
   agent makes carries it. So `--agent scout` also deletes scout's un-integrated *project*
   observations: build steps, layout, conventions it noticed while working, which would have
   been filed to the project scope had you integrated first.

   Integrated pages are untouched, so integrating before you purge is how you keep that
   work. Purging an agent that has captured but never integrated throws away everything it
   saw.

   The two neighbouring scopes do **not** reach it, and both limits surprise people:

   - **`--project` does not reach agent scopes.** An agent's self-facts are store-wide by
     construction — one agent name resolves to one scope no matter which repo the agent was
     working in when it learned something about itself — so what an agent learned about
     *itself* while working on a project lives in `agents/<name>/`, not in that project's
     scope, and purging the project leaves it in place.
   - **`--session` cannot reach them at all.** Session provenance lives on inbox entries, an
     agent scope has no inbox, and an integrated page carries no `src=` trailer. There is
     nothing in `agents/<name>/` for a session id to match. Purge the page, or the agent.

**The agent scope is a separation-of-concerns boundary, not a security boundary.** An agent
name is self-declared and unauthenticated: mehmory takes whatever `MEHMORY_AGENT` or
`identity.agent` says, validates only that it is a safe directory segment, and never verifies
that the process claiming it is the agent it says it is. And because every agent in a repo
shares one project inbox, anything that can write that inbox can stamp an entry with any
agent's name, which integration will then file into that agent's scope. The isolation agent
scopes give you is read-side and cooperative — it keeps distinct agents from being *merged*
into one indistinct self. It does not keep one agent out of another's memory, and it is not
a control to rely on against anything adversarial.

## Why mehmory never rewrites git history

Purge deletes and commits; it does not run `git filter-repo`, `git rebase`, or anything else
that rewrites existing commits. This is a deliberate boundary, not a missing feature:
rewriting history reliably requires a tool dependency (`git filter-repo` must be present or
vendored), and a rewrite that fails partway through has no honest fail-open answer — unlike a
failed commit, which just leaves the store dirty and recoverable. Silently deleting from the
working tree while claiming the content is "gone" would also be a false privacy claim, which
is worse than stating the limitation plainly.

If you need content removed from the store's git history entirely, run:

```bash
git filter-repo --path <path-to-purge> --invert-paths
```

from inside `~/.mehmory` (or `$MEHMORY_HOME`). `purge`'s own output prints this recipe every
time it runs, not just this document — you shouldn't have to already know it exists.

## Uninstalling is not deleting your data — on either harness

These are two separate operations, on both Claude Code and Codex CLI:

- **Uninstalling** — removing the Claude Code plugin from your marketplace installation, or
  running `mehmory init --host codex --uninstall` — stops the hooks and skills from running.
  It does **not** touch `~/.mehmory` (or `$MEHMORY_HOME`) — your wiki, inbox, and log stay
  exactly where they are, untouched and readable, because neither harness's install mechanism
  ever owned that directory in the first place.
- **Deleting your data** is `mehmory purge --all` (or a narrower purge scope), and it's the
  only thing that removes content from the store, regardless of which harness it came from.

If you uninstall and reinstall later (or on another machine, pointed at the same
`$MEHMORY_HOME`), your memory is exactly as you left it — nothing needs restoring, because
nothing was removed. This is worth stating plainly, because a user's first assumption about
"uninstall" is usually "and my data goes with it" — here it doesn't.

**Codex uninstall may reformat a hand-edited `hooks.json`.** Content correctness is
unconditional: `--uninstall` never removes an entry it did not write, and the file is backed
up (`<file>.mehmory.bak`) before any change. But if `$CODEX_HOME/hooks.json` was not already in
the canonical 2-space JSON Codex itself writes — hand-edited with different spacing, for
example — uninstall's rewrite renders the whole file back out in that canonical form. Nothing
is added, removed, or reordered in the data; the bytes around it can still change. See
`docs/CLI.md` for the byte-identity guarantee and the assumption it depends on.

## Restoring from `purge --export`

`mehmory purge <target> --export <path>` copies the target(s) to `<path>` *before* deleting
them from the store — see `docs/CLI.md` for the full flag contract, including that the
command aborts (exit 3, deletes nothing) if the export copy itself fails.

To restore an exported page or scope, copy the exported files back into the corresponding
location under `~/.mehmory` (or `$MEHMORY_HOME`) and re-run `mehmory init` if the store's
git repo needs re-adding the file — `init` is idempotent and safe to run again. There's no
separate `mehmory restore` command in v1: a purge export is a plain copy of markdown files, and
putting them back is a plain file copy, on purpose — no second code path to keep working.
