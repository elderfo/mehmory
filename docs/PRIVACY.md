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

Every write to the store passes through `redact()`, which applies the built-in corpus in
`redact.ts` plus anything you add under `secrets.patterns` in `config.json`. That setting
defaults to `[]`; adding or clearing user patterns never removes built-ins. Coverage includes:

- AWS `AKIA` access keys and `ASIA` temporary keys, plus secret-access-key assignments.
- GitHub `ghp_`, `ghs_`, `ghu_`, `gho_`, `ghr_`, and fine-grained `github_pat_` tokens.
- Anthropic `sk-ant-`; OpenAI `sk-proj-`, `sk-svcacct-`, `sk-admin-`, and legacy 48-character
  `sk-` keys; numeric-ID Slack `xox[abposr]-` tokens and Slack webhook URLs.
- Stripe `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, and `whsec_`; Google `AIza` keys;
  three-part `eyJ` JWTs; npm `npm_`, GitLab `glpat-`, and SendGrid `SG.` tokens.
- Bearer tokens, including base64 slash, plus and padding; `Authorization: Basic` headers;
  Azure `AccountKey=` and `SharedAccessKey=` assignments with at least 16 value characters.
- Generic, RSA, OPENSSH, EC, DSA, encrypted, and PGP private-key blocks, including truncated
  blocks without a footer (redacted through the end of the input) and differing private-key
  footer labels. Header words may be separated by spaces or tabs. After optional spaces
  or tabs, a newline, literal `\n` or `\r\n` escape, or at least 20 consecutive base64
  characters starts the body. This covers space-flattened keys and bodies touching the
  header. Other separators (including double-escaped newlines, CR-only, backslash-newline,
  and `<br>`) or short first lines are covered when a private-key footer begins within
  8192 characters of the header. A prose mention without a body or nearby footer can
  remain readable. Public-key footers do not terminate a private-key block.
- URL user/password or empty-user credentials, including `postgres`, `postgresql`, `mysql`,
  `mongodb`, `mongodb+srv`, `redis`, `rediss`, and `amqp` schemes, not only HTTP/FTP/SSH.
  Passwords may contain single slashes and `@` characters before the final `@host`;
  `//` ends userinfo scanning. Quotes and commas stop password matching when an `@` still
  follows, so neighboring JSON fields stay readable; a password that itself contains a comma or
  an apostrophe is still redacted.
- JSON/YAML/env assignments to secret names such as `api_key`, `password`, and `secret`,
  camelCase names such as `secretAccessKey`, `clientSecret`, and `refreshToken`, PascalCase
  names such as `ClientSecret` and `SecretKey`, and backslash-escaped quotes in stringified
  JSON. Unseparated names ending in `token`, `password`, `passwd`, `secret`, `apikey`,
  `secretkey`, `privatekey`, `accesskey`, `signingkey`, or `sshkey` (such as `csrftoken` in
  cookies) are covered too. CamelCase suffixes are case-sensitive: ordinary words like
  `monkey`, `turkey`, and `hotkey` are not secret names, but PascalCase identifiers such as
  `HotKey`, `PublicKey`, and `PrimaryKey` are treated as secret names and their values are
  redacted. Backtick-quoted
  template-literal values are redacted, including multiline values and escaped backticks.
  Unquoted `=` values include Unicode, brackets, pipes, and embedded equals signs up to a
  shell value delimiter; this widened charset applies to `=` assignments,
  not bare `key: value` colon forms.
  `)` terminates unquoted values; backticks also end unquoted inline values. Even
  placeholders like `${PASSWORD}` are redacted.
  Uppercase `.env` assignments and inline secret-named environment variables (including
  `PGPASSWORD`, `MYSQL_PWD`, `DB_PASS`, `REDIS_AUTH`, `SECRET_KEY_BASE`, `PASSPHRASE`,
  `SSH_PASSPHRASE`, `APP_PIN`, and `docker run -e POSTGRES_PASSWORD=...`) are covered even
  after quotes, backticks, and shell punctuation. `PIN` must be a whole-word `_PIN` suffix,
  not the end of a word like `SPIN`. Inline env values recognize backslash-escaped double
  quotes and shell ANSI-C `$'...'` quoting. Unterminated backslash-escaped double quotes
  are redacted through the next whitespace or double quote.
  Common environment settings like `PATH` and `*_EXAMPLE` variables are exempt from env
  matching, but another built-in or custom pattern can still catch a recognizable token
  inside them. Bare generic assignments exempt only numbers with at most 19 integer
  digits, lowercase language/type keywords (such as `true`, `false`, `str`, and `int`),
  and values identical to their key name (`this.password = password`). Capitalized values
  and property expressions are redacted; quoted values remain subject to redaction.

If the filter encounters an unexpected internal failure, it returns **`[REDACTED]` for the
entire input**, never unchecked text, without throwing or stopping the harness. Inputs larger
than 256 KiB of UTF-8 text also become `[REDACTED]` before pattern matching or whitelist
processing. Both cases log the informational `E_REDACT_FAILED` code without the input or
exception message. Injection slices each part to 64,000 UTF-16 code units before filtering,
well above the largest supported frame budget and below the byte cap even for Unicode. This
preserves the useful prefix of oversized pages instead of replacing their entire section.
If redaction shortens a sliced part, its last unfinished token is replaced too, so the
cutoff cannot expose a credential prefix. The final budget cut still happens after redaction.
Built-in matching avoids repeated JWT/scheme/assignment rescans and has per-pattern
250 KiB adversarial timing tests; the size cap is not a hard execution deadline for arbitrary
custom regexes. An invalid user regex is instead logged and skipped, with built-in filtering
still applied.

**Redaction reaches both harnesses.** There is one store and one `redact()` call on the write
path, regardless of whether the session that produced the text was Claude Code or Codex CLI —
harness identity is not a redaction input, so nothing about a Codex-originated capture is
filtered differently or filtered less.

**This is best-effort pattern matching, not a PII-safe guarantee.** It catches secrets that
look like the shapes above. It does not reliably catch:

- Personally identifiable information in prose (names, addresses, phone numbers written as
  sentences rather than key=value pairs).
- Secrets in free prose or formats the built-in patterns don't recognize (a custom internal
  token scheme, or a credential without a recognized prefix or assignment). Inside prose,
  bare colon assignments need a structural delimiter or line end; at a line/structure
  boundary, whitespace also delimits their values.
- Unprefixed values assigned to exempt `*_EXAMPLE` variables, and unquoted generic values
  that are numbers with at most 19 integer digits, lowercase language/type keywords,
  or identical to their key name.
  Azure `AccountKey` and `SharedAccessKey` values shorter than 16 characters are also exempt.
- `Authorization: Token` and `Authorization: ApiKey` headers, `curl -u user:pass`,
  `mysql -p` passwords, Go `:=` assignments, and cookies without another recognizable
  secret shape.
- Provider tokens with `hf_`, `dop_v1_`, `pypi-`, or `xapp-` prefixes.
- A short key prefix left by distill truncation before enough characters remain to satisfy
  a provider pattern's minimum length.
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

Three more things follow from working-tree deletion:

1. **It removes files, not history.** mehmory never rewrites your store's git history — see
   the recipe below for when you need that.
2. **`--session <id>` only reaches un-integrated inbox entries.** A session id survives in the
   store in exactly one place: the `src=<sessionId>` trailer on an inbox entry that hasn't
   been integrated into a page yet. Once `/mehmory:integrate` folds an entry into a wiki page,
   the session id that produced it is gone — the page just has a fact on it. Purging a
   session cannot reach content that already made it into a page; if you need that gone,
   purge the page itself. Page purges remove both live and archived copies in the selected
   scope and their matching index summaries; the dry-run preview lists both. Only normative
   `- [[slug]] — summary` index lines are removed; freeform references and lines without the
   summary separator are untouched. Agent-scope pages are discoverable by slug too; use
   `purge <slug> --agent <name>` to resolve ambiguity, `--project <key>` for a project, or
   `--global` for global memory. Agent names must be safe single directory segments, and
   `--agent` only qualifies a page purge, not a whole-scope deletion. Project and agent
   scopes stay distinct even if a project's alias key is `agent/<name>`.
   Catalog summaries are still in git history, so removing a page from history alone is
   not enough — selectively rewrite the old index lines as well, without deleting the
   whole index.
   Session ids must contain at least 8 characters with no whitespace; invalid ids are
   rejected as usage errors before confirmation (exit 1).
   Within that limit it is deliberately **store-wide**: `--session` clears matching entries
   from *every* inbox, not only the project you happen to be standing in. Session ids are
   unique, so there is no false positive to fear, and a session that touched two projects is
   exactly the case where a scope-limited delete would leave a copy behind.
3. **`--global` is its own scope**, not "every project" — it removes the entire `global/`
   directory: identity, index, inbox, log, pages, archive and any other global files. Project
   and agent directories stay. No global skeleton survives; a later `mehmory init` or
   SessionStart can recreate empty templates, not the deleted content. Until reinitialized,
   CLI commands requiring `global/identity.md` report a missing store.

**The agent scope is a separation-of-concerns boundary, not a security boundary.** An agent
name is self-declared and unauthenticated: mehmory takes whatever `MEHMORY_AGENT` or
`identity.agent` says, validates only that it is a safe directory segment, and never verifies
that the process claiming it is the agent it says it is. And because every agent in a repo
shares one project inbox, anything that can write that inbox can stamp an entry with any
agent's name, which integration will then file into that agent's scope. An agent scope also
has no whole-scope purge flag of its own yet: delete that directory by hand (or use
`purge --all`), though individual pages can be purged with `--agent <name>` or an
unambiguous slug. Un-integrated entries stamped with that name stay in the project inbox.
The isolation that agent scopes give you is read-side and cooperative — it keeps distinct agents from being *merged* into
one indistinct self. It does not keep one agent out of another's memory, and it is not
a control to rely on against anything adversarial.

**Purge does not touch queued jobs under `.state/queue/`.** Pending, claimed or failed job
payloads may contain distilled text, even after `purge --all`; inspect and remove those
separately if you need that data gone too.

Every purge target is checked for store containment before export or mutation. A refused
page or index target leaves both the page and catalog unchanged. Export also checks every
source recursively, so a symlinked `pages/` or `archive/` directory cannot copy outside-store
content into the export.

If an inbox clear fails after earlier scopes were cleared, purge reports the deleted and
remaining entry counts and exits 3; it does not roll back those earlier clears or create a
purge commit. Inspect `git -C <store> status`, then retry the remaining deletion. Content
already deleted is still reachable in the store's prior history.

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
  exactly where they are, untouched and readable. Codex uninstall's temporary lock and skill
  staging directories live under `$CODEX_HOME`, not in the store; it does not even create an
  absent store. Installing with `init --host codex` does initialize the store, as the other
  `init` variants do.
- **Deleting your data** is `mehmory purge --all` (or a narrower purge scope), and it's the
  only thing that removes content from the store, regardless of which harness it came from.

If you uninstall and reinstall later (or on another machine, pointed at the same
`$MEHMORY_HOME`), your memory is exactly as you left it — nothing needs restoring, because
nothing was removed. This is worth stating plainly, because a user's first assumption about
"uninstall" is usually "and my data goes with it" — here it doesn't.

**Codex uninstall may reformat a hand-edited `hooks.json`.** Content correctness is
unconditional: `--uninstall` never removes an entry it did not write, and the file is backed
up (`<file>.mehmory.bak`, mode `0600`) before any change. Each modification replaces that
backup with the immediately preceding contents, not the state before the first installation.
Symlinked `config.toml` and `hooks.json` are resolved with realpath and edited at their real
targets, preserving the symlinks. Their private backups live next to those targets, which
may be outside `$CODEX_HOME` (for example, in a dotfiles repository). Unresolvable or dangling
configuration symlinks are refused without replacement.
A semantic no-op preserves the exact bytes in any formatting and takes no backup; a
foreign-only registry reports nothing to remove. When uninstall actually removes mehmory's
entries, it renders the remaining file as canonical 2-space JSON. Foreign entries survive,
but the bytes around them can still change if the original file used other formatting. See
`docs/CLI.md` for the byte-identity guarantee and the assumption it depends on.

Uninstall stages skill directories before removing hooks. A staging or hook-edit failure
restores the skills. If deletion of staged directories then fails, hooks and discoverable
skills remain removed together; the error names the leftover directory under `$CODEX_HOME`
for cleanup. The store is still untouched. An uninstall on a never-installed home creates
neither `$CODEX_HOME` nor a hook registry; removing skills without an existing registry does
not create one either. Install preflights skill sources and symlink-sensitive targets before
editing configuration, so those refusals leave no partial installation or backups behind.

## Restoring from `purge --export`

`mehmory purge <target> --export <path>` copies the target(s) to `<path>` *before* deleting
them from the store — see `docs/CLI.md` for the full flag contract, including that the
command aborts (exit 3, deletes nothing) if the export copy itself fails.

To restore an exported page or scope, copy the exported files back into the corresponding
location under `~/.mehmory` (or `$MEHMORY_HOME`) and re-run `mehmory init` if the store's
git repo needs re-adding the file — `init` is idempotent and safe to run again. There's no
separate `mehmory restore` command in v1: a purge export is a plain copy of markdown files, and
putting them back is a plain file copy, on purpose — no second code path to keep working.
