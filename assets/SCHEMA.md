---
schema_version: "1"
---

# mehmory Schema

This file is **user-editable guidance**. You can freely rewrite, reorganize, and extend this document without breaking the tool. The tool's behavior is controlled by code, not by this file. Use it to document your own house style, page conventions, and memory practices.

## Page Types

Every page has a `type` field in its frontmatter. Valid types:

- **decision** — choices made and their rationale (decision records)
- **procedure** — step-by-step workflows and runbooks
- **entity** — reference data: APIs, databases, services, team members
- **preference** — personal settings, tooling, style (user-level only)
- **gotcha** — pitfalls, gotchas, things to watch out for

## Decay Classes

Pages are marked with an optional `decay` field indicating how aggressively they age:

- **evergreen** — reference that is rarely stale; kept front-and-center and exempt from mechanical decay
- **ephemeral** — things in flux (current focus, session TODOs, draft ideas); refreshed or deleted on each integrate
- **default** — normal pages; the only class the mechanical rules touch (>60d demoted, >90d archived)

Staleness thresholds are enforced mechanically at SessionStart; editorial staleness (whether a page is still true) is judged by `lint` during integrate.

## Size Caps

Hard limits enforced at write time:

- **identity.md** ≤ ~200 tokens — user prefs, tooling, style
- **project.md** ≤ ~200 tokens — project summary, current focus
- **index.md** ≤ ~500 tokens — catalog of pages, one line per page
- **page** ≤ ~1500 tokens — single topic; split if over (pages are not files, facts are)

Token estimation uses chars/4 with ±20% tolerance.

## House Style

- **Caveman-telegraphic bullets** — short facts per bullet, more signal per injected token
- **Full prose only where nuance demands** — avoid elaborate sentences
- **Wikilinks** — use `[[page-name]]` to link between pages (backlinks/orphans are derived, never stored)
- **Scope rule** — user-level facts (preferences, tooling) → `global/`; codebase facts → `projects/<key>/`

## Secret Filter Limitation

The secret filter is best-effort pattern matching. It catches common forms — AWS keys, GitHub tokens, bearer tokens, private-key blocks, `.env`-shaped secrets, URL-embedded credentials — but it does **not** reliably catch PII or secrets written in prose. Do not rely on it as your only safeguard against writing sensitive material into memory.

## Frontmatter

Every page carries:

- **updated** (ISO date) — last edit timestamp
- **type** (string) — one of: decision, procedure, entity, preference, gotcha
- **refs** (optional, string) — source references or provenance

Example:

```
---
updated: 2026-07-29
type: decision
refs: session:abc123
---
```

## Git Commits

Memory operations are automatically committed to git:

- `integrate` — merges inbox entries into pages
- `lint` — staleness sweeps, orphan cleanup
- `onboard` — initial inbox seeding
- Session lifecycle — captures, decay passes

Every commit has a message summarizing the operation and entry count. The full git history is your audit trail.
