# Security Policy

## Supported versions

mehmory is pre-1.0. Only the latest released version receives fixes.

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/elderfo/mehmory/security/advisories/new)
— do not open a public issue.

Include what you can: affected version, reproduction steps, and impact. Expect an initial
response within a week.

## Scope

mehmory reads harness transcripts and writes markdown to a git-backed store at `~/.mehmory`
(or `$MEHMORY_HOME`, if set). The security-relevant surfaces are:

- **The secret filter** (`src/core/redact.ts`) — a pattern-based best-effort filter that runs
  before anything is written to the store. Its known limits are documented in
  `docs/PRIVACY.md`. A pattern that lets a real credential class through is a valid report;
  so is a bypass of the filter's call sites.
- **Store writes** — path traversal, or a write that escapes the configured store root
  (whether that root came from the default or from `$MEHMORY_HOME`).
- **Hook execution** — anything that turns transcript content into executed code.

Out of scope: the contents of your own memory store, and secrets that reach the store because
the filter has no pattern for a bespoke credential format (that's a feature request — see
`docs/PRIVACY.md`).
