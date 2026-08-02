---
layout: home

hero:
  name: mehmory
  text: Your project's memory, in markdown
  tagline: A deliberately "meh"-tier improvement in memory and continuity for Claude Code and Codex CLI, built from boring parts. Git-backed markdown at ~/.mehmory. No embeddings, no MCP server, no cloud.
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: Why mehmory
      link: /why
    - theme: alt
      text: GitHub
      link: https://github.com/elderfo/mehmory

features:
  - title: Boring parts, on purpose
    details: A directory of markdown in a git repo. Read it in your editor, grep it, diff it, revert it. Nothing in the storage layer is a black box you have to trust.
  - title: Capture is deterministic
    details: Hooks on SessionStart, UserPromptSubmit, Stop, PreCompact and SessionEnd do the capturing. No LLM call in the hot path, no token spend, and every hook fails open — a broken memory layer never breaks your session.
  - title: Judgment is model-driven
    details: Deciding what a fact means and where it belongs is the model's job, not a regex's. /mehmory:integrate reads the inbox, writes pages, updates the index and commits.
  - title: Budgeted, not bloated
    details: The always-on context frame is capped at 800 tokens and the cap is asserted by a test. Memory that quietly eats your context window is a regression, not a feature.
  - title: Retrieval you can measure
    details: A golden query set reports Recall@1 and Recall@3 on every scoring change, and reports the paraphrase split separately — the measured size of what keyword matching cannot do.
  - title: Local-first and deletable
    details: Secrets are redacted on the way in. purge removes pages, a session's un-integrated captures, projects or everything, with an export first. mehmory never rewrites your git history.
---
