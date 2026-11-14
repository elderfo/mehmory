---
name: remember
description: 'Save a fact, decision, correction or gotcha to the mehmory inbox right now, so the next integrate files it into the wiki. Use when the user says remember this, save this, note that, or do not forget. For a one-liner there is a faster path with no skill load at all — start a prompt with the `remember:` prefix (for example `remember: staging deploys need the VPN`) and the UserPromptSubmit hook captures it inline. Writes to ~/.mehmory (outside the project), so Claude Code may prompt for permission.'
allowed-tools: Bash
---

# Remember

Append one or more entries to the inbox. Nothing else — no page editing, no commit. The
inbox is the staging area; `integrate` does the filing.

**Faster alternative, worth telling the user once:** prefixing any prompt with
`remember:` captures the rest of that line to the inbox with zero latency and no skill
load. This skill exists for multi-fact saves and for when the user asks in prose.

## Do it

```bash
HOME_DIR="${MEHMORY_HOME:-$HOME/.mehmory}"
```

Use the `session: <id>` line inside the injected `<mehmory-memory>` frame to identify
this session; decode the id if JSON-quoted. Read
`$HOME_DIR/.state/<sha256(session-id)>.json`, hashing the exact UTF-8 id with Node's
`crypto.createHash('sha256')`. Use that file's `project_key` for `key`, its `session_id`
for `src`, and its `host` for `host`.
If the frame names a session but only
`$HOME_DIR/.state/<sha256(session-id)>.finalized.json` exists, read `project_key` and
`host` from that marker; it is the same session retired by the idle sweep.

Legacy fallback only when the frame has no session line: the newest state file is a
hint, not proof of identity. Confirm its session and project with the user before using it:

```bash
grep -l '"session_id"' "$HOME_DIR"/.state/*.json 2>/dev/null \
  | grep -v '\.finalized\.json$' \
  | xargs -r ls -t 2>/dev/null | head -1 | xargs -r cat
```

Prefer `mehmory inbox-tx`. If the CLI is unavailable, replace it with the installed
bundle command below, using the same subcommand and stdin JSON. Do not install packages.

- Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-tx.mjs"`.
- Codex: read `${CODEX_HOME:-$HOME/.codex}/hooks.json`; the registered mehmory
  `SessionStart` command gives the absolute `hooks/session-start.mjs` path. Run Node on
  its sibling `hooks/inbox-tx.mjs` — this is the installed package, not a path to search for.
- Pi git install: `node "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/elderfo/mehmory/hooks/inbox-tx.mjs"`.
  For a project-local Pi install, the package is under `.pi/git/github.com/elderfo/mehmory/`.

Then append:

```bash
printf '%s\n' "$FACT" \
  | node -e '
      const fs = require("node:fs");
      const [inbox, key, host, src] = process.argv.slice(1);
      const text = fs.readFileSync(0, "utf8").trimEnd();
      const input = { inbox, key, entries: [{ text, src }] };
      if (host) input.host = host;
      process.stdout.write(JSON.stringify(input));
    ' "$HOME_DIR/projects/<key>/inbox.md" "<key>" "<host>" "<session id>" \
  | mehmory inbox-tx append
```

`host` is which harness you are running under — `claude-code`, `codex` or `pi` — and it is
what the entry is attributed to. Take it from the state file rather than guessing; omit the
field entirely if the file has no `host`, and the helper derives it from `src` instead.
Never send a value that is not one of those three: the helper rejects it, which is the
point — a wrong host is a silently mis-attributed memory.

Stdout is `{"appended":n,"skipped":m}`; `skipped` means that exact text was already in
the inbox, which is a success, not a failure. Non-zero exit: report the stderr line and
tell the user the fact was **not** saved.

## Rules

- **Never hand-write the entry line into inbox.md.** Entries carry a machine-computed
  id (a truncated sha256) that you cannot produce by hand, and a malformed line breaks
  the snapshot/clear transaction that protects the inbox. Always go through the helper.
- One fact per entry. Several facts in one breath means several array elements.
- Write it as the user would want to read it in six months: specific, self-contained,
  no "as discussed above".
- User-level facts (preferences, tooling, style) go to `$HOME_DIR/global/inbox.md`
  instead of the project inbox.
- Secrets are stripped by the helper before the entry lands, but the filter is
  best-effort — do not deliberately save credentials.
