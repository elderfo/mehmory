---
name: pause
description: Pause mehmory capture and injection for this session when the user says pause memory, stop capturing, or mute mehmory. Uses a locked helper to write the pause flag under ~/.mehmory/.state (outside the project), so permission may be required. Reversible with resume.
allowed-tools: Read Bash
---

# Pause

Pause the explicitly identified current session through the transactional helper.

1. Obtain the current harness session id from reliable session context or ask the user
   for it. A recent state file is not proof of identity when sessions run concurrently.
   If the id is unavailable, stop and ask; do not select a state file by recency.
2. Pass that exact id as `session_id` in JSON on stdin:

   ```bash
   mehmory inbox-tx pause <<'JSON'
   {"session_id":"<current session id>"}
   JSON
   ```

   If the CLI is unavailable, use the installed bundle with the same payload:
   `node <installed-mehmory>/hooks/inbox-tx.mjs pause`.

3. Confirm the returned `session_id` and `paused: true` only after exit 0. On failure,
   report the error; a busy session can be retried, and a finalized session needs its
   harness SessionStart/resume before changing the flag. Never edit state files directly.

Paused sessions emit no capture, injection, or pointers. The helper changes only the
session flag under the session lock; it preserves the cursor, counter, topic, and origin.

For persistent disabling, offer user-managed `config.json` changes instead. Resume clears
only the session flag and does not override a hook disabled in config.
