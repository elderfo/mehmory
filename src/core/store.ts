/**
 * Store initialization (A6: exclusive owner of git init and layout creation, idempotent under crash).
 *
 * initStore() creates the directory structure and copies SCHEMA.md.
 * It is idempotent: running it twice, or recovering from a half-initialized state,
 * completes initialization without error or duplication.
 */

import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mehmoryHome } from './home.js';
import { logError, type MehmoryError } from './errors.js';
import { mkdir, pathExists, readFile, atomicWrite } from './fs.js';

/** Result type for store initialization (A11: never throws across boundary). */
export type InitStoreResult =
  | { ok: true; home: string }
  | { ok: false; error: MehmoryError };

/**
 * Initialize the mehmory store (A6).
 *
 * Creates:
 * - Root directory (~/.mehmory)
 * - Directory structure: global/, projects/, .state/
 * - Initial content files in global/: identity.md, index.md, log.md, inbox.md
 * - Copies assets/SCHEMA.md to ~/.mehmory/SCHEMA.md (never overwrites user edits)
 * - Initializes git repository (git init)
 *
 * Idempotent:
 * - Run twice: no error, no duplication
 * - Half-initialized (missing .git): completes git init
 * - Half-initialized (missing layout): creates layout directories and files
 *
 * If SCHEMA.md already exists and appears to be user-modified (contains local edits),
 * it is left alone. Schema updates are the user's responsibility; the tool never
 * clobbers their edited copy.
 */
export function initStore(): InitStoreResult {
  const home = mehmoryHome();

  try {
    // Step 1: Create root directory
    mkdir(home);

    // Step 2: Create directory structure
    const globalDir = join(home, 'global');
    const globalPagesDir = join(globalDir, 'pages');
    const projectsDir = join(home, 'projects');
    const stateDir = join(home, '.state');

    mkdir(globalDir);
    mkdir(globalPagesDir);
    mkdir(projectsDir);
    mkdir(stateDir);

    // Step 3: Create initial content files in global/ (idempotently, never overwrite)
    ensureFileContent(join(globalDir, 'identity.md'), IDENTITY_TEMPLATE);
    ensureFileContent(join(globalDir, 'index.md'), INDEX_TEMPLATE);
    ensureFileContent(join(globalDir, 'log.md'), LOG_TEMPLATE);
    ensureFileContent(join(globalDir, 'inbox.md'), INBOX_TEMPLATE);

    // Step 4: Copy SCHEMA.md (never overwrite user edits)
    ensureSchemaFile(home);

    // Step 4b: .gitignore and config.json, created only when absent (A6 amendment).
    //
    // config.json is written **empty**, not fully defaulted: a defaults file on disk
    // pins every default forever, so a later default change becomes a silent no-op for
    // every existing user (the shadow-defaults failure A4 rejects). It exists only so
    // E_CONFIG_PARSE's `$EDITOR <path>` fix opens a file that is already there.
    ensureAbsentFile(join(home, '.gitignore'), STORE_GITIGNORE);
    ensureAbsentFile(join(home, 'config.json'), '{}\n');

    // Step 5: Initialize git (idempotently, only if .git doesn't exist)
    const gitDir = join(home, '.git');
    if (!pathExists(gitDir)) {
      try {
        execFileSync('git', ['init', home], {
          stdio: 'pipe',
          encoding: 'utf-8',
        });
        // Disable commit signing for the store itself, so it holds even for git
        // invocations that don't route through commitPaths (a user running
        // `git -C ~/.mehmory commit` by hand, or a future caller). Without this
        // the user's global commit.gpgsign makes every store commit block on the
        // signing agent. Set per-repo, so the user's own repos are untouched.
        execFileSync('git', ['-C', home, 'config', 'commit.gpgsign', 'false'], {
          stdio: 'pipe',
          encoding: 'utf-8',
        });
      } catch (err) {
        const error: MehmoryError = {
          code: 'E_STORE_INIT',
          kind: 'actionable',
          what: err instanceof Error ? err.message : 'git init failed',
          consequence: 'Store is initialized but git repository was not created',
          // The resolved home, not a literal `~/.mehmory`: the documented
          // MEHMORY_HOME override would otherwise make this command wrong.
          fix: `git -C ${home} init`,
        };
        logError(error);
        return { ok: false, error };
      }
    }

    return { ok: true, home };
  } catch (err) {
    const error: MehmoryError = {
      code: 'E_STORE_INIT',
      // Informational: "check file permissions and disk space" is prose, not a
      // runnable command, and U10 admits only the latter under `Fix:`.
      kind: 'informational',
      what: err instanceof Error ? err.message : 'Store initialization failed',
      consequence: 'The mehmory store could not be created or updated',
    };
    logError(error);
    return { ok: false, error };
  }
}

/**
 * Create a file with content if it doesn't exist.
 * If it exists and is empty or matches the default, update it (refresh).
 * If it exists with non-default content, leave it alone (user edit).
 */
function ensureFileContent(path: string, defaultContent: string): void {
  if (pathExists(path)) {
    const existing = readFile(path);
    // Only refresh if the file is empty or matches the default
    if (existing.length === 0 || existing === defaultContent) {
      atomicWrite(path, defaultContent);
    }
    // Otherwise, leave the user's edited version alone
  } else {
    atomicWrite(path, defaultContent);
  }
}

/** Write `content` only when the file is absent. Keeps `initStore` idempotent: a second
 * run leaves a user-edited file — or a deliberately emptied one — exactly as it is. */
function ensureAbsentFile(path: string, content: string): void {
  if (!pathExists(path)) atomicWrite(path, content);
}

/** Store `.gitignore`: `.state/` is machine-local scratch (cursors, warnings, the error
 * log) and must never enter the memory repo's history. */
const STORE_GITIGNORE = '.state/\n';

/**
 * Copy SCHEMA.md to store (never overwrite user edits).
 * If SCHEMA.md already exists, assume it's user-owned and leave it alone (A4).
 */
function ensureSchemaFile(home: string): void {
  const schemaPath = join(home, 'SCHEMA.md');

  if (!pathExists(schemaPath)) {
    // First time: write the schema template
    atomicWrite(schemaPath, SCHEMA_TEMPLATE);
  }
  // Else: schema file exists, user owns it; never overwrite (A4)
}

/** Template for identity.md */
const IDENTITY_TEMPLATE = `---
updated: 2026-01-01
type: preference
---

# Identity

Your preferences, tools, and style guide for memory.

- TODO: Add your preferences here
`;

/** Template for index.md */
const INDEX_TEMPLATE = `---
updated: 2026-01-01
type: entity
---

# Index

Catalog of pages in this scope. One line per page.
`;

/** Template for log.md */
const LOG_TEMPLATE = `---
updated: 2026-01-01
type: entity
---

# Log

Session operations log (append-only).
`;

/** Template for inbox.md */
const INBOX_TEMPLATE = `---
updated: 2026-01-01
type: entity
---

# Inbox

Captured entries awaiting integration.
`;

/**
 * `schema_version` of the template this build ships (A20).
 *
 * `doctor` compares the store's own `SCHEMA.md` against this and warns on drift. It is
 * deliberately **not** `FORMAT_VERSION`: that versions the machine format, so tying the
 * warning to it would fire on every code-only bump with nothing the user could do about
 * it. Interpolated into the template below so the two can never disagree.
 */
export const TEMPLATE_SCHEMA_VERSION = '1';

/** Template for SCHEMA.md (embedded copy of assets/SCHEMA.md) */
const SCHEMA_TEMPLATE = `---
schema_version: "${TEMPLATE_SCHEMA_VERSION}"
---

# mehmory Schema

This file is **user-editable guidance**. You can freely rewrite, reorganize, and extend this document without breaking the tool. The tool's behavior is controlled by code, not by this file. Use it to document your own house style, page conventions, and memory practices.

## Page Types

Every page has a \`type\` field in its frontmatter. Valid types:

- **decision** — choices made and their rationale (decision records)
- **procedure** — step-by-step workflows and runbooks
- **entity** — reference data: APIs, databases, services, team members
- **preference** — personal settings, tooling, style (user-level only)
- **gotcha** — pitfalls, gotchas, things to watch out for

## Decay Classes

Pages are marked with an optional \`decay\` field indicating how aggressively they age:

- **evergreen** — reference that is rarely stale; kept front-and-center and exempt from mechanical decay
- **ephemeral** — things in flux (current focus, session TODOs, draft ideas); refreshed or deleted on each integrate
- **default** — normal pages; the only class the mechanical rules touch (>60d demoted, >90d archived)

Staleness thresholds are enforced mechanically at SessionStart; editorial staleness (whether a page is still true) is judged by \`lint\` during integrate.

### Ephemeral content: refresh or delete, every pass

\`ephemeral\` has **no age threshold and no config key** — an ephemeral fact is one whose truth expires on its own schedule, which no timer can predict. Every \`integrate\` pass therefore visits all ephemeral-marked content and does one of exactly two things to each item:

- **Refresh** it, if this pass produced evidence that it is still true (restate it in current terms and bump \`updated\`), or
- **Delete** it.

There is no third option. "Leave it and check next time" is what makes a current-focus line quietly describe last quarter's work. Deletion is safe: the store is a git repo, so the line is recoverable and the page history stays intact.

This applies to whole pages marked \`decay: ephemeral\` and to ephemeral fields inside otherwise stable pages — the canonical one being the current-focus line in \`project.md\`.

## Index Lines

\`index.md\` carries exactly one line per page, in this format:

\`\`\`
- [[deploy-process]] — staging via GitHub Actions, prod is manual
\`\`\`

The \`[[slug]]\` matches the page filename (\`pages/deploy-process.md\`) and is how the tooling associates an index line with its page — the decay pass moves and demotes index lines by finding that wikilink. Keep the format exact: leading \`- \`, the wikilink, then the summary. The summary text is yours to write.

Lines below a \`## Archive\` heading are pages the mechanical decay pass demoted; leave them there. A page moved into \`archive/\` loses its index line entirely — it is still greppable, just no longer in the catalog.

## Inbox Entries Are Machine-Formatted

\`inbox.md\` is a normal markdown file you can read and edit, but each captured entry is a **single line** ending in an HTML comment that carries its machine identity:

\`\`\`
- staging deploys need the VPN <!--mehmory id=... src=... ts=...-->
\`\`\`

That trailing comment is invisible when the markdown is rendered and is what lets tooling deduplicate replays and clear exactly the entries an integrate consumed — including when a capture lands mid-integrate. So:

- Editing or rewording the **text** of an entry is fine.
- **Preserve the trailing comment**, and keep each entry on one line.
- Deleting a whole entry line is fine (it simply never gets integrated).
- Do not hand-write new entries; the id is a hash. Use \`/mehmory:remember\`, or the \`remember:\` prompt prefix.

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
- **Wikilinks** — use \`[[page-name]]\` to link between pages (backlinks/orphans are derived, never stored)
- **Scope rule** — user-level facts (preferences, tooling) → \`global/\`; codebase facts → \`projects/<key>/\`

## Secret Filter Limitation

The secret filter is best-effort pattern matching. It catches common forms — AWS keys, GitHub tokens, bearer tokens, private-key blocks, \`.env\`-shaped secrets, URL-embedded credentials — but it does **not** reliably catch PII or secrets written in prose. Do not rely on it as your only safeguard against writing sensitive material into memory.

## Frontmatter

Every page carries:

- **updated** (ISO date) — last edit timestamp
- **type** (string) — one of: decision, procedure, entity, preference, gotcha
- **refs** (optional, string) — source references or provenance

Example:

\`\`\`
---
updated: 2026-07-29
type: decision
refs: session:abc123
---
\`\`\`

## Git Commits

Memory operations are automatically committed to git:

- \`integrate\` — merges inbox entries into pages
- \`lint\` — staleness sweeps, orphan cleanup
- \`onboard\` — initial inbox seeding
- Session lifecycle — captures, decay passes

Every commit has a message summarizing the operation and entry count. The full git history is your audit trail.
`;
