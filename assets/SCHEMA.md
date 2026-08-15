---
schema_version: "2"
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

### Ephemeral content: refresh or delete, every pass

`ephemeral` has **no age threshold and no config key** — an ephemeral fact is one whose truth expires on its own schedule, which no timer can predict. Every `integrate` pass therefore visits all ephemeral-marked content and does one of exactly two things to each item:

- **Refresh** it, if this pass produced evidence that it is still true (restate it in current terms and bump `updated`), or
- **Delete** it.

There is no third option. "Leave it and check next time" is what makes a current-focus line quietly describe last quarter's work. Deletion is safe: the store is a git repo, so the line is recoverable and the page history stays intact.

This applies to whole pages marked `decay: ephemeral` and to ephemeral fields inside otherwise stable pages — the canonical one being the current-focus line in `project.md`.

## Index Lines

`index.md` carries exactly one line per page, in this format:

```
- [[deploy-process]] — staging via GitHub Actions, prod is manual
```

The `[[slug]]` matches the page filename (`pages/deploy-process.md`) and is how the tooling associates an index line with its page — the decay pass moves and demotes index lines by finding that wikilink. Keep the format exact: leading `- `, the wikilink, then the summary. The summary text is yours to write.

Lines below a `## Archive` heading are pages the mechanical decay pass demoted; leave them there. A page moved into `archive/` loses its index line entirely — it is still greppable, just no longer in the catalog.

## Inbox Entries Are Machine-Formatted

`inbox.md` is a normal markdown file you can read and edit, but each captured entry is a **single line** ending in an HTML comment that carries its machine identity:

```
- staging deploys need the VPN <!--mehmory id=... src=... host=claude-code ts=...-->
```

That trailing comment is invisible when the markdown is rendered and is what lets tooling deduplicate replays and clear exactly the entries an integrate consumed — including when a capture lands mid-integrate. So:

- Editing or rewording the **text** of an entry is fine.
- **Preserve the trailing comment**, and keep each entry on one line.
- Deleting a whole entry line is fine (it simply never gets integrated).
- Do not hand-write new entries; the id is a hash. Use the remember skill (or slash command, on harnesses that have one), or the `remember:` prompt prefix.

Any line that does not match the entry format — headings, your own notes — is left alone by every tool.

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
- **Scope rule** — route by what a fact is *about*: user-level facts (preferences, tooling) → `global/`; codebase facts → `projects/<key>/`; an agent's own facts (its style, its non-project knowledge) → `agents/<name>/`. The `agent=` stamp names *whose* scope a self-fact belongs to; it is set on every entry that agent captured, so it never decides *whether* a fact is a self-fact

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
