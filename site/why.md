# Why mehmory

## The problem

Every Claude Code or Codex CLI session starts from zero.

You spend the first twenty minutes re-explaining the architecture, the deploy story, why
that one module is weird, and the decision you already made twice. Then `/clear` lands, or
the context window compacts, and the session that finally understood your project is gone.
Tomorrow you do it again.

The usual answers ask for a lot of trust. A vector database you can't read. A hosted service
holding your codebase's institutional knowledge. An MCP server between you and your own
notes. Retrieval quality nobody measures, in a store nobody can open.

## The answer

Your project's memory is a directory of markdown files in a git repo at `~/.mehmory`.

That's the whole storage layer. A Claude Code or Codex CLI session reads it and writes it with
ordinary file operations. You can `cat` it, grep it, edit it in your editor, `git diff` it, and revert
a bad write with `git revert`. When memory is a text file, "what does it think it knows?" is
answerable in one command instead of being an act of faith.

```bash
mehmory search "what did we decide about auth"
```

## What "meh" buys you

The name is a promise about scope. mehmory is not trying to be a cognitive architecture. It
does one boring job well, and the boring choices are the point:

**Nothing to run.** No server, no daemon, no MCP process, no API key, no account. A CLI, a
handful of hooks, and a folder.

**Nothing to lose.** Your memory is in your filesystem, under your git, on your machine.
Uninstalling the plugin doesn't delete it — and mehmory is explicit that those are two
different operations, with a documented export and restore path for the one that does.

**Nothing to break your session.** Every hook fails open. If a hook errors, times out, or
finds a corrupt store, the session continues as if mehmory weren't installed. Memory tooling
that can take down your editor isn't a productivity gain.

## What it actually does

**Captures without asking.** Deterministic hooks distill your sessions into an inbox as you
work — no model call, no token spend, no interruption. `mehmory onboard` backfills the same
inbox from the Claude Code transcripts you already have, so a project with history doesn't
start empty.

**Integrates with judgment.** Sorting a fact into the right page is a reading-comprehension
problem, so a model does it. `/mehmory:integrate` reads the inbox and the schema, decides
where each fact belongs, writes the pages, updates the index, and commits.

**Ages gracefully.** Memory that never forgets is memory that drowns you in last quarter's
decisions. Aged pages get demoted and flagged, never silently dropped — you can always see
what was down-weighted and why.

**Stays inside a budget.** Two things load before you type a word: the injected context frame
and the plugin's skill descriptions. Both are capped, and both caps are enforced by tests.
Raising one is a commit that says why, not a surprise you discover in your token bill.

**Redacts before it writes.** The secret filter runs on the way into the store, and its real
limits are documented rather than oversold.

## Honest limits

- **Retrieval is keyword matching over one scan.** No index, no embeddings. Fast, greppable,
  debuggable — and genuinely worse at paraphrase than a vector store. The paraphrase gap is
  measured and published in the golden set rather than hidden.
- **The first session after onboarding sees a stub.** Onboarding seeds raw material; the wiki
  gets built by the first `/mehmory:integrate`. The session where "it already knows my
  project" comes true is the second one. Anything claiming otherwise is overselling it.
- **Integration is in-session work.** It costs tokens, because judgment costs tokens.
- **`onboard`'s transcript backfill is Claude Code only.** It mines `~/.claude/projects/*/`;
  there's no equivalent transcript history to mine on Codex, so a Codex project starts from
  the hooks capturing forward, same as a fresh Claude Code project would.
- **Codex's hook-trust behavior on first run is unverified.** Codex CLI can require an
  explicit trust decision before running a freshly written hook; whether that gates mehmory's
  first Codex invocation is not something this project could measure without a real user's
  configuration. See the troubleshooting doc.

<div class="tip custom-block" style="padding-top: 8px">

Convinced enough? [Quickstart](/quickstart) takes about five minutes. Curious how it's
built? [How it works](/how-it-works).

</div>
