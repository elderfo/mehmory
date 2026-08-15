# Configuration

mehmory reads `<store home>/config.json`. `mehmory init` writes an **empty** `{}` there, not
a fully-defaulted file — every key below has a real default that applies whether or not you
set it, and a defaults file on disk would pin every current default forever, silently
freezing out future default changes. Set only the keys you want to override; `loadConfig()`
deep-merges your file over the defaults below.

**Store home:** every path in this document is `~/.mehmory` by convention, but the real
location is `$MEHMORY_HOME` when that environment variable is set. If you've set it, read
every `~/.mehmory/...` path below as `$MEHMORY_HOME/...` instead.

There are **15** config groups. Each is listed with its keys, real defaults, and whether the
key is actually read anywhere in the codebase — "not honored" means the key exists in the
schema and can be set, but nothing currently reads it, so setting it changes nothing.

## Which of these can you change freely?

The store is per machine, so nothing here is shared with a team — but the keys still split
into two kinds, and the difference matters when you go back to a memory six months later.

**Content-shaping — changing these changes what your memory ends up containing.** Turn one
down and the wiki you have a year from now is a different wiki; the effect is invisible on
the day you change it and unrecoverable afterwards, because the material was never captured.
Change these deliberately, and prefer to note *why* somewhere your future self will find:

| Key | What a change actually does |
|---|---|
| `hooks.*.enabled` | Off means that lifecycle event captures or injects **nothing**. A disabled `stop` hook is a session that leaves no trace. `doctor` warns for exactly this reason. Off never *destroys* material: a disabled `session_end` leaves the session pending, and the next `session_start` finalizes it — which is also how Codex, which has no session-end event, captures every session's tail. |
| `hosts.*.enabled` | Off means that harness captures or injects **nothing**, across every lifecycle event. Turning off `hosts.codex.enabled` mid-adoption is a silent gap in the record for every Codex session until it is turned back on. |
| `stop.capture_threshold` | How often mid-session capture fires. Raise it and short sessions stop producing entries at all. |
| `distill.max_loss_percent` | The tolerance for unparseable transcript lines before mehmory admits the pass was lossy. Raising it silences the signal, not the loss. |
| `secrets.patterns` / `secrets.whitelist` | The filter every capture and injection passes through. A wrong whitelist entry is a secret in the store, permanently. |
| `decay.archive_days` / `decay.purge_days` | When a page is demoted in retrieval and when it leaves `pages/` (A22). Nothing is deleted, but retrieval ranking and the shape of `index.md` both move. |
| `injection.budget_tokens` | The always-on context cap. Lowering it truncates what every session starts with. |

**Preference — safe to tune to taste, reversible, affects only this machine's ergonomics.**
Get one wrong and you notice immediately, and setting it back undoes the damage:
`inbox.nudge_entries` / `nudge_bytes`, `match.jaccard` / `cache_ttl_ms`,
`session_state.max_age_days`, `lock.*`, `queue.*`, `log.rotation_size_mb`,
`warning.rate_limit_ms`, `identity.aliases`.

The rule behind the split: a preference key changes how mehmory *behaves at you*; a
content-shaping key changes what mehmory *keeps*. Only one of those is undoable.

## `injection`

```json
{ "injection": { "budget_tokens": 800 } }
```

This budget governs **stored memory only**. `SessionStart` also emits a fixed
`<mehmory-routing>` block of about 80 tokens telling the model how to use that memory
(follow pointers before grepping, what `(stale)` means, how to capture). It sits outside
`budget_tokens` on purpose — a large wiki must not crowd out the lines explaining what to
do with it — and is capped by its own test rather than by this key.

- `budget_tokens` — total token budget for `SessionStart`'s injected identity + project +
  index content. At the default 800, the split is identity 200 / project 200 / index 400.
  All three scale with the total in that 1:1:2 ratio, so raising or lowering
  `budget_tokens` moves them together — 2000 gives identity 500 / project 500 / index 1000
  — and the index absorbs whatever the flooring leaves over. **Honored**
  (`buildInjection`).

**The named-agent slot.** When the running agent has a name (see `identity.agent` below),
its own scope is injected too, and it gets a fixed 200-token slot **on top of**
`budget_tokens` rather than a share of it — a named agent's total is `budget_tokens + 200`.
The three shares above are computed from `budget_tokens` alone, so they come out exactly as
an unnamed agent gets them at the same setting: the slot is purely additive, and an unnamed
agent's allocation is byte-identical to what it was before agent scopes existed.
Truncation runs in priority order — index, then project, then the agent slot, then identity.
Identity is never emptied, only shortened. The agent slot is held to the same rule wherever
the budget can seat it, and yields entirely only on a budget too small for both — identity
is the one that must survive.

## `decay`

```json
{ "decay": { "enabled": true, "archive_days": 60, "purge_days": 90 } }
```

- `enabled` — turns the mechanical decay pass on or off.
- `archive_days` — index pages older than this move below the Archive divider. **Also the
  staleness horizon for retrieval** (A22): past it, a page is scored ×0.7 in both
  `matchPages` and `search` and comes back flagged `stale`. Raising this makes retrieval
  trust old pages for longer; it does not make them disappear either way.
- `purge_days` — index pages older than this move into `archive/`. Archived pages stay
  searchable, scored ×0.5 — lower than the staleness demotion, because archival is an
  explicit act rather than mere drift.

  All three **honored** (`decay.ts`, and `archive_days` additionally by `match.ts` /
  `search.ts`). Neither demotion multiplier is configurable: they are calibration
  constants in `schema/format.ts`, and `archive_days` already controls when demotion
  starts. Nothing is ever excluded from retrieval for age.

## `secrets`

```json
{ "secrets": { "patterns": ["/AKIA[0-9A-Z]{16}/", "..."], "whitelist": [] } }
```

- `patterns` — extra regexes (as `RegExp.prototype.toString()` strings, e.g. `"/foo/i"`),
  **additive** to the five built-in patterns baked into `redact.ts` (AWS keys, GitHub
  tokens, bearer tokens, private-key blocks, `.env`-shaped `KEY=value` lines). **The default
  value of `patterns` is a literal mirror of those five built-in patterns** — meaning every
  `redact()` call runs the built-ins *plus* five duplicates of themselves. This is correct
  (redacting twice changes nothing) but a real, currently-unowned cost: every capture and
  every injection pays for five redundant regex passes. Changing the default to `[]` is a
  behavior change nobody has approved this run, so it's recorded here rather than silently
  fixed.
- `whitelist` — literal substrings exempt from redaction. **Whitelist semantics are precise
  and matter**: an entry exempts a secret match only when the entry **fully contains** that
  match. A partial overlap still redacts — a whitelist entry can never make the built-in
  patterns catch less than they otherwise would. (The first implementation of this run had
  it backwards and would have let whole AWS keys leak through a whitelist entry that merely
  overlapped one; it was caught during verification and fixed with regression tests. Do not
  "simplify" this back to substring-overlap exemption.)

  Both keys **honored** (`redact()`, threaded via `config.secrets`, never read from disk
  inside `redact` itself — loaded once per process and passed down).

## `stop`

```json
{ "stop": { "capture_threshold": 15 } }
```

- `capture_threshold` — Stop-hook invocations since the last capture before the next capture
  + block fires. **Honored** (`src/hooks/stop.ts`, `src/core/capture.ts`).

## `hooks`

```json
{
  "hooks": {
    "session_start": { "enabled": true },
    "user_prompt_submit": { "enabled": true },
    "stop": { "enabled": true },
    "pre_compact": { "enabled": true },
    "session_end": { "enabled": true }
  }
}
```

Per-hook on/off switch, one object per hook (object rather than a bare boolean so a later run
can add per-hook keys without another shape change). **Honored** — every hook checks its own
`hooks.<name>.enabled` before doing anything. `mehmory doctor` warns, naming the key, whenever
a hook is found disabled.

## `hosts`

```json
{
  "hosts": {
    "claude-code": { "enabled": true },
    "codex": { "enabled": true }
  }
}
```

Per-harness on/off switch, so you can adopt the Codex side gradually — turn capture on for one
harness while leaving the other exactly as it is. Off for a harness means **every** hook that
harness invokes skips capture, injection and pointers entirely: no inbox writes, no context
injection, nothing recorded beyond the stats line that a hook fired at all. Unlike `hooks.*`,
which is per lifecycle event, this key is per harness — the two combine, so `hooks.stop.enabled:
false` still turns Stop off everywhere even if both harnesses are individually on.

**Honored** (`src/core/hook.ts`) — `runHook()` resolves the invoking harness and checks
`hosts.<host>.enabled` before reading stdin or calling into the hook body, the same choke point
every event (`session_start`, `user_prompt_submit`, `stop`, `pre_compact`, `session_end`) runs
through.

## `inbox`

```json
{ "inbox": { "nudge_entries": 10, "nudge_bytes": 8192 } }
```

- `nudge_entries` / `nudge_bytes` — `SessionStart` nudges toward `/mehmory:integrate` once the
  inbox reaches either threshold. **Honored** (`src/hooks/session-start.ts`).

## `session_state`

```json
{ "session_state": { "max_age_days": 14 } }
```

- `max_age_days` — age at which `.state/<session-id>.json` files are swept during
  `SessionStart` maintenance. **Honored** (`src/core/session.ts`).

## `match`

```json
{ "match": { "jaccard": 0.7, "cache_ttl_ms": 300000 } }
```

- `jaccard` — similarity threshold against the cached prompt token set that skips a repeat
  `UserPromptSubmit` pointer lookup.
- `cache_ttl_ms` — how long that cache entry stays valid.

  Both **honored** (`src/core/session.ts`, `src/hooks/user-prompt-submit.ts`).

## `identity`

```json
{ "identity": { "aliases": {}, "agent": "" } }
```

- `aliases` — maps a project key you no longer want (a split-off or merged repo) to the key
  its memory should resolve to instead. **Honored** (`src/core/identity.ts`,
  `src/core/scopes.ts`) — scope resolution checks aliases before matching a `--project`
  selector.
- `agent` — the name of the agent running on this machine. A named agent gets a scope of its
  own at `agents/<name>/` holding what it is — its preferences, its style, its non-project
  knowledge — captures stamped with that name, and that scope injected at `SessionStart`.
  Empty (the default) means unnamed: no agent scope, and capture, recall, and on-disk layout
  are exactly as they were before agent scopes existed. **Honored** (`src/core/agent.ts`,
  `src/core/capture.ts`, `src/cli/scope.ts`).

  The name must be a single path segment matching `[a-z0-9._-]+`, at most 64 characters, and
  may not be `.`, start with a dot, or be one of the tokens the scope grammar already owns
  (`global`, `projects`, `agents`, `all`). An invalid name is **refused, never rewritten**:
  mehmory warns with `E_AGENT_NAME_INVALID` and the agent runs unnamed rather than adopting
  a mangled identity.

  **`identity.agent` is store-wide, not per process.** It is one value in one
  `config.json`, so every agent on the machine that reads it resolves to the same name and
  the same scope. If you run more than one agent here, leave it unset and name each process
  through the `MEHMORY_AGENT` environment variable at launch instead — that is what the
  environment variable is for, and it takes precedence over this key when both are set.
  `mehmory init` never writes an agent name, so having one stays an explicit act.

## `lock`

```json
{ "lock": { "retry_count": 50, "retry_delay_ms": 100, "stale_ms": 30000 } }
```

- **Not honored.** `src/core/lock.ts` uses its own hardcoded constants
  (`LOCK_RETRY_COUNT`, `LOCK_RETRY_INTERVAL_MS`, `LOCK_STALE_MS` in `src/core/fs.ts`) that
  happen to equal these defaults today. Changing any of these three keys in `config.json`
  currently changes nothing — the values here describe the built-in behavior but do not
  configure it.

## `queue`

```json
{ "queue": { "max_claims": 3, "stale_ms": 30000, "claims_per_start": 1 } }
```

- `claims_per_start` — **honored** (`src/hooks/session-start.ts`, A16's maintenance-lane
  bound: at most this many durable jobs claimed per `SessionStart`).
- `max_claims` and `stale_ms` — **not honored.** `src/core/queue.ts` uses its own hardcoded
  `QUEUE_STALE_MS` constant for staleness, and nothing reads `max_claims` at all. Setting
  either currently changes nothing.

## `distill`

```json
{ "distill": { "max_loss_percent": 10 } }
```

- `max_loss_percent` — the unparseable-line ratio above which a distill pass logs
  `E_DISTILL_LOSSY`. **Honored** (`src/core/capture.ts`).

**The retention floor is not configurable.** A captured turn is dropped, before it reaches
the inbox, when fewer than 8 characters of it survive stripping the harness's own blocks.
That threshold is a constant in `src/distill/patterns.ts`, not a key here — it exists to
clear one-word acknowledgements ("yes", "agreed", "Ship it") and is deliberately low
enough that it never assumes a turn is written in a space-separated script. If you find
yourself wanting to tune it, that is worth an issue rather than a local edit: the useful
signal is which real turn it dropped.

## `log`

```json
{ "log": { "rotation_size_mb": 5 } }
```

- `rotation_size_mb` — **partially honored.** It controls rotation of `stats.jsonl`
  (`src/core/stats.ts`). It does **not** control rotation of `errors.log`, which is hardcoded
  to rotate at 5 MB in `src/core/errors.ts` regardless of this setting. If you change this
  value expecting it to move the errors-log rotation point too, it will not.

## `warning`

```json
{ "warning": { "rate_limit_ms": 3600000 } }
```

- `rate_limit_ms` — **not honored.** `src/core/errors.ts` rate-limits repeated warnings using
  its own hardcoded one-hour constant. Setting this key currently changes nothing.

## `MEHMORY_HOME`

Not a `config.json` key — an environment variable that overrides the store's location for
every command and hook. Every path example in this document, and in every other doc in this
set, should be read relative to `$MEHMORY_HOME` when it's set, not literally `~/.mehmory`.

## `MEHMORY_AGENT`

Not a `config.json` key — the environment variable that names the agent running this
process. It takes precedence over `identity.agent`, which is the machine-wide default
underneath it, and it is the only way to give two agents on one machine different names:
`config.json` is store-wide, so a name set there applies to every process that does not
override it.

Set it and the agent gets a scope of its own at `~/.mehmory/agents/<name>/`. Leave it
unset with no `identity.agent` either and the agent runs unnamed — it captures to and
recalls from the project scope and `global/` exactly as it always has, and no agent scope
is created for it.

The same value on two different surfaces unifies them: one agent reachable over two
platforms shares one memory when both sessions declare the same name.

An unusable name is refused rather than repaired, and the agent runs unnamed — see
`E_AGENT_NAME_INVALID` in `docs/TROUBLESHOOTING.md`.

## `CODEX_HOME`

Also not a `config.json` key — the environment variable Codex itself uses for its
configuration directory, honored by `mehmory init --host codex` and by `mehmory doctor`'s
Codex checks. Unset, both read `~/.codex`.

Two files there are mehmory's business, and **neither belongs to mehmory**:

| File | What mehmory does to it |
|---|---|
| `$CODEX_HOME/hooks.json` | Merges in one entry per captured event (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`). Entries owned by other tools are never touched. |
| `$CODEX_HOME/config.toml` | Sets `[features] hooks = true`, which Codex requires before any hook runs. Nothing else in the file is read or rewritten, and uninstall never turns it back off. |

Before either file is modified it is copied to `<file>.mehmory.bak`. A run that changes
nothing takes no backup, so that copy always holds the state from just before the last real
change. See `docs/CLI.md` for the merge rules and `docs/TROUBLESHOOTING.md` for the
`E_CODEX_*` codes `doctor` reports against these paths.
