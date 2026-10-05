---
name: pause
description: Pause mehmory capture and injection for this session when the user says pause memory, stop capturing, or mute mehmory. Uses a locked helper to write the pause flag under ~/.mehmory/.state (outside the project), so permission may be required. Reversible with resume.
allowed-tools: Read Bash
---

# Pause

Pause the explicitly identified current session through the transactional helper.

1. Read the `session: <id>` line inside the injected `<mehmory-memory>` frame; decode
   the id if JSON-quoted. It identifies `$HOME_DIR/.state/<sha256(session-id)>.json`
   (`HOME_DIR` is `${MEHMORY_HOME:-$HOME/.mehmory}`). If the line is unavailable, ask the
   user for the id. A recent state file is not proof of identity when sessions run concurrently.
2. Pass that exact id as `session_id` in JSON on stdin:

   ```bash
   mehmory inbox-tx pause <<'JSON'
   {"session_id":"<current session id>"}
   JSON
   ```

   If the CLI is unavailable, use the installed bundle with the same payload and `pause`:
   - Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-tx.mjs" pause`.
   - Codex: read `${CODEX_HOME:-$HOME/.codex}/hooks.json`; use the `inbox-tx.mjs`
     sibling of the absolute `session-start.mjs` path in mehmory's `SessionStart` command.
   - Pi git install: `node "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/elderfo/mehmory/hooks/inbox-tx.mjs" pause`.
     For a project-local install, the package is under `.pi/git/github.com/elderfo/mehmory/`.

3. Confirm the returned `session_id` and `paused: true` only after exit 0. On failure,
   report the error; a busy session can be retried, and a finalized session needs its
   harness SessionStart/resume before changing the flag. Never edit state files directly.

Paused sessions emit no capture, injection, or pointers. The helper changes only the
session flag under the session lock; it preserves the cursor, counter, topic, and origin.

For persistent disabling, offer user-managed `config.json` changes instead. Resume clears
only the session flag and does not override a hook disabled in config.
