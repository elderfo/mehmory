---
name: resume
description: Turn mehmory capture and injection back on for this session after /mehmory:pause. Use when the user says resume memory, unpause, or start capturing again. Clears one flag under ~/.mehmory/.state (outside the project), so Claude Code may prompt for permission. It never re-enables a hook that was switched off in config.json — that stays the user's explicit choice.
allowed-tools: Read Edit Bash
---

# Resume

Clear the session pause flag. Nothing else.

## Mechanism

Find this session's state file the same way `pause` did — newest `.state/*.json`
carrying a `session_id` field:

```bash
HOME_DIR="${MEHMORY_HOME:-$HOME/.mehmory}"
STATE=$(grep -l '"session_id"' "$HOME_DIR"/.state/*.json 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | head -1)
cat "$STATE"
```

Set `"paused": false` with Edit, leaving `cursor`, `stop_count`, `topic` and
`project_key` untouched. Confirm which session id you resumed.

If `paused` is already `false`, say so — capture was never off — and check the next
section before promising the user that memory is working.

## What resume must NOT do

Resume is strictly the inverse of pause and nothing more. **Never** edit
`$HOME_DIR/config.json`, and never flip a `hooks.<name>.enabled` key back to `true`.
Precedence is subtractive: the session flag only ever disables. A hook disabled in
config was disabled deliberately, at project or global level, by the user — clearing it
from inside a session would silently undo a decision made outside it.

If capture still looks dead after resuming, read `config.json` and **tell** the user
which hooks are disabled there and that they must re-enable them by hand:

```bash
cat "$HOME_DIR/config.json"
```
