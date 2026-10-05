---
name: resume
description: Resume mehmory capture and injection after a session pause when the user says resume memory, unpause, or start capturing again. Uses a locked helper to clear the flag under ~/.mehmory/.state (outside the project), so permission may be required. Hooks disabled in config stay disabled.
allowed-tools: Read Bash
---

# Resume

Clear only the pause flag for the explicitly identified current session.

1. Read the `session: <id>` line inside the injected `<mehmory-memory>` frame; decode
   the id if JSON-quoted. It identifies `$HOME_DIR/.state/<sha256(session-id)>.json`
   (`HOME_DIR` is `${MEHMORY_HOME:-$HOME/.mehmory}`). If unavailable, ask the user for
   the id; concurrent sessions make recency unsafe.
   If the frame names a session but only
   `$HOME_DIR/.state/<sha256(session-id)>.finalized.json` exists, read `project_key` and
   `host` from that marker; it is the same session retired by the idle sweep.
2. Pass that exact id as `session_id` in JSON on stdin:

   ```bash
   mehmory inbox-tx resume <<'JSON'
   {"session_id":"<current session id>"}
   JSON
   ```

   If the CLI is unavailable, use the installed bundle with the same payload and `resume`:
   - Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-tx.mjs" resume`.
   - Codex: read `${CODEX_HOME:-$HOME/.codex}/hooks.json`; use the `inbox-tx.mjs`
     sibling of the absolute `session-start.mjs` path in mehmory's `SessionStart` command.
   - Pi git install: `node "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/elderfo/mehmory/hooks/inbox-tx.mjs" resume`.
     For a project-local install, the package is under `.pi/git/github.com/elderfo/mehmory/`.

3. Confirm the returned `session_id` and `paused: false` only after exit 0. Report any
   failure instead of promising capture is enabled. Busy sessions can be retried; for a
   finalized session, retry after the next turn. This operation unpauses a live session,
   not a finalized generation. Never edit state files directly.

The helper preserves every other state field under the session lock. It leaves
`config.json` unchanged: a hook disabled there remains disabled. If memory still looks
inactive, read the config and tell the user which hooks they must re-enable themselves.
