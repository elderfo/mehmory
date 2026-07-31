# Privacy

mehmory stores everything as markdown in a git repository at `~/.mehmory` (or `$MEHMORY_HOME`,
see `docs/CONFIG.md`). You can read it, `grep` it, edit it, and inspect its history with
ordinary git tools at any time. This document covers what mehmory does to keep secrets out of
that store, what happens when you ask it to delete something, and what to do if you need
content gone from history too — those are three different questions with three different
answers.

## The secret filter's real limits

Every write to the store passes through `redact()`, which applies five built-in regex
patterns (AWS keys, GitHub tokens, bearer tokens, private-key blocks, `.env`-shaped
`KEY=value` lines) plus anything you add under `secrets.patterns` in `config.json`.

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

**Deleting anything takes two invocations.** The first run previews the targets, prints the
confirmation token scaled to what you're about to lose, and exits 4 having changed nothing;
the second run supplies that token on stdin
(`printf '%s\n' 'DELETE ALL' | mehmory purge --all`). `--yes` collapses the two into one when
you're scripting. There is no interactive `y/N` prompt anywhere in mehmory — a single
keystroke is not enough friction for `--all`, and the CLI's output contract does not allow a
command to print a preview and then block for an answer.

Three more things follow from working-tree deletion:

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

## Uninstalling the plugin is not deleting your data

These are two separate operations:

- **Uninstalling the plugin** (removing it from your Claude Code plugin marketplace
  installation) stops the hooks and skills from running. It does **not** touch
  `~/.mehmory` — your wiki, inbox, and log stay exactly where they are, untouched and
  readable, because the plugin never owned that directory in the first place.
- **Deleting your data** is `mehmory purge --all` (or a narrower purge scope), and it's the
  only thing that removes content from the store.

If you uninstall the plugin and reinstall it later (or on another machine, pointed at the same
`$MEHMORY_HOME`), your memory is exactly as you left it — nothing needs restoring, because
nothing was removed. This is worth stating plainly, because a user's first assumption about
"uninstall" is usually "and my data goes with it" — here it doesn't.

## Restoring from `purge --export`

`mehmory purge <target> --export <path>` copies the target(s) to `<path>` *before* deleting
them from the store — see `docs/CLI.md` for the full flag contract, including that the
command aborts (exit 3, deletes nothing) if the export copy itself fails.

To restore an exported page or scope, copy the exported files back into the corresponding
location under `~/.mehmory` (or `$MEHMORY_HOME`) and re-run `mehmory init` if the store's
git repo needs re-adding the file — `init` is idempotent and safe to run again. There's no
separate `mehmory restore` command in v1: a purge export is a plain copy of markdown files, and
putting them back is a plain file copy, on purpose — no second code path to keep working.
