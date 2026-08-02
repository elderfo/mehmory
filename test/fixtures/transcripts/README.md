# Transcript Fixtures

These fixtures are **normative test data** (ADR A7). Each pair consists of:
- `*.jsonl` — a redacted transcript from a real session
- `*.distilled.json` — the expected distill output for that transcript

The test asserts **exact equality** between the actual distill output and the expected output.

## Hosts

A `codex-` filename prefix marks a **Codex rollout**, read through `readCodexRollout`;
everything else is a **Claude Code transcript**, read through `readTranscript`. The contract
test routes every fixture through `readSession(path, host)`, so the fixtures assert against
the record stream production actually produces rather than a hand-parsed approximation.

Codex fixtures carry the event envelope (`{timestamp, type, payload}`) verbatim, including
the lines the reader is expected to drop — `token_count`, `function_call`, and the
`response_item` echo of a user turn that would otherwise be filed twice.

## Redaction

Claude Code fixtures come from `~/.claude/projects/`, Codex fixtures from
`~/.codex/sessions/`. Both are redacted to remove:
- Project paths and directory names
- File names and code snippets
- User names and identifiable information
- API tokens, session IDs (replaced with placeholders)
- Timestamps (replaced with relative markers)

Redaction preserves the **structure** and **record types** of the original, so the distill patterns work on authentic data without leaking personal information.

## Fixture Quality

A bad fixture becomes a permanent bad contract. Before adding a new fixture:
1. Verify the original transcript manually
2. Confirm redaction removed all sensitive data
3. Review the expected distill output by hand
4. Ensure the fixture demonstrates the specific pattern(s) it claims to test
