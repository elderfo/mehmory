---
name: pause
description: Stop mehmory capturing and injecting for the rest of this session — no inbox writes, no context injection, no pointers. Use when the user says pause memory, stop capturing, mute mehmory, or is about to work on something they do not want remembered. Writes one flag file under ~/.mehmory/.state (outside the project), so Claude Code may prompt for permission. Reversible with /mehmory:resume.
allowed-tools: Read, Edit, Bash
---

# Pause

Set the session pause flag. Paused sessions emit nothing at all — that silence is how
the user verifies it worked.

## Mechanism

The pause flag lives in this session's state file,
`$MEHMORY_HOME/.state/<session-id>.json`, as `"paused": true`. A skill is not told its
own session id, so find the file by recency — the hooks touch it on every invocation, so
the newest state file carrying a `session_id` field is this session's:

```bash
HOME_DIR="${MEHMORY_HOME:-$HOME/.mehmory}"
STATE=$(grep -l '"session_id"' "$HOME_DIR"/.state/*.json 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | head -1)
echo "$STATE" && cat "$STATE"
```

Read it, then set `"paused": true` with Edit, leaving every other field exactly as it
is (`cursor`, `stop_count`, `topic`, `project_key` all matter). Confirm to the user
which session id you paused.

**If no state file exists**, no hook has run yet in this session — say so and ask the
user to send one more prompt first, rather than guessing at a filename. A state file you
invent under the wrong id pauses nothing.

## Persistent, cross-session disabling

The session flag dies with the session. To keep a hook off permanently, the user edits
`$HOME_DIR/config.json` instead — offer this, do not do it unasked:

```json
{ "hooks": { "stop": { "enabled": false } } }
```

Valid hook keys: `session_start`, `user_prompt_submit`, `stop`, `pre_compact`,
`session_end`. Precedence is subtractive: session pause > project config > global
config, and any layer that says off wins. Tell the user plainly that a config disable is
silent — nothing will remind them it is set, and `/mehmory:resume` will not undo it.
