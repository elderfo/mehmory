import {
  applyDistillJob,
  buildScopeInjection,
  claimJob,
  completeJob,
  estimateTokens,
  finalizePendingSessions,
  inboxBytes,
  runHook,
  scopePaths,
  skillRef,
  storeExists,
  storeIsUnpopulated
} from "./chunk-L2WWXAGT.mjs";
import {
  ARCHIVE_DIR,
  ARCHIVE_DIVIDER,
  atomicWrite,
  failOpen,
  isPaused,
  listDir,
  loadConfig,
  logError,
  mehmoryHome,
  mkdir,
  pageAgeDays,
  parseIndexLine,
  pathExists,
  pendingWarnings,
  readFile,
  readFrontmatter,
  readInboxEntries,
  rename,
  stat,
  sweepSessionState,
  tryProjectLock
} from "./chunk-Q3XCVOKA.mjs";

// src/core/store.ts
import { join } from "path";
import { execFileSync } from "child_process";
function initStore() {
  const home = mehmoryHome();
  try {
    mkdir(home);
    const globalDir = join(home, "global");
    const globalPagesDir = join(globalDir, "pages");
    const projectsDir = join(home, "projects");
    const stateDir = join(home, ".state");
    mkdir(globalDir);
    mkdir(globalPagesDir);
    mkdir(projectsDir);
    mkdir(stateDir);
    ensureFileContent(join(globalDir, "identity.md"), IDENTITY_TEMPLATE);
    ensureFileContent(join(globalDir, "index.md"), INDEX_TEMPLATE);
    ensureFileContent(join(globalDir, "log.md"), LOG_TEMPLATE);
    ensureFileContent(join(globalDir, "inbox.md"), INBOX_TEMPLATE);
    ensureSchemaFile(home);
    ensureAbsentFile(join(home, ".gitignore"), STORE_GITIGNORE);
    ensureAbsentFile(join(home, "config.json"), "{}\n");
    const gitDir = join(home, ".git");
    if (!pathExists(gitDir)) {
      try {
        execFileSync("git", ["init", home], {
          stdio: "pipe",
          encoding: "utf-8"
        });
        execFileSync("git", ["-C", home, "config", "commit.gpgsign", "false"], {
          stdio: "pipe",
          encoding: "utf-8"
        });
      } catch (err) {
        const error = {
          code: "E_STORE_INIT",
          kind: "actionable",
          what: err instanceof Error ? err.message : "git init failed",
          consequence: "Store is initialized but git repository was not created",
          // The resolved home, not a literal `~/.mehmory`: the documented
          // MEHMORY_HOME override would otherwise make this command wrong.
          fix: `git -C ${home} init`
        };
        logError(error);
        return { ok: false, error };
      }
    }
    return { ok: true, home };
  } catch (err) {
    const error = {
      code: "E_STORE_INIT",
      // Informational: "check file permissions and disk space" is prose, not a
      // runnable command, and U10 admits only the latter under `Fix:`.
      kind: "informational",
      what: err instanceof Error ? err.message : "Store initialization failed",
      consequence: "The mehmory store could not be created or updated"
    };
    logError(error);
    return { ok: false, error };
  }
}
function ensureFileContent(path, defaultContent) {
  if (pathExists(path)) {
    const existing = readFile(path);
    if (existing.length === 0 || existing === defaultContent) {
      atomicWrite(path, defaultContent);
    }
  } else {
    atomicWrite(path, defaultContent);
  }
}
function ensureAbsentFile(path, content) {
  if (!pathExists(path)) atomicWrite(path, content);
}
var STORE_GITIGNORE = ".state/\n";
function ensureSchemaFile(home) {
  const schemaPath = join(home, "SCHEMA.md");
  if (!pathExists(schemaPath)) {
    atomicWrite(schemaPath, SCHEMA_TEMPLATE);
  }
}
var IDENTITY_TEMPLATE = `---
updated: 2026-01-01
type: preference
---

# Identity

Your preferences, tools, and style guide for memory.

- TODO: Add your preferences here
`;
var INDEX_TEMPLATE = `---
updated: 2026-01-01
type: entity
---

# Index

Catalog of pages in this scope. One line per page.
`;
var LOG_TEMPLATE = `---
updated: 2026-01-01
type: entity
---

# Log

Session operations log (append-only).
`;
var INBOX_TEMPLATE = `---
updated: 2026-01-01
type: entity
---

# Inbox

Captured entries awaiting integration.
`;
var TEMPLATE_SCHEMA_VERSION = "1";
var SCHEMA_TEMPLATE = `---
schema_version: "${TEMPLATE_SCHEMA_VERSION}"
---

# mehmory Schema

This file is **user-editable guidance**. You can freely rewrite, reorganize, and extend this document without breaking the tool. The tool's behavior is controlled by code, not by this file. Use it to document your own house style, page conventions, and memory practices.

## Page Types

Every page has a \`type\` field in its frontmatter. Valid types:

- **decision** \u2014 choices made and their rationale (decision records)
- **procedure** \u2014 step-by-step workflows and runbooks
- **entity** \u2014 reference data: APIs, databases, services, team members
- **preference** \u2014 personal settings, tooling, style (user-level only)
- **gotcha** \u2014 pitfalls, gotchas, things to watch out for

## Decay Classes

Pages are marked with an optional \`decay\` field indicating how aggressively they age:

- **evergreen** \u2014 reference that is rarely stale; kept front-and-center and exempt from mechanical decay
- **ephemeral** \u2014 things in flux (current focus, session TODOs, draft ideas); refreshed or deleted on each integrate
- **default** \u2014 normal pages; the only class the mechanical rules touch (>60d demoted, >90d archived)

Staleness thresholds are enforced mechanically at SessionStart; editorial staleness (whether a page is still true) is judged by \`lint\` during integrate.

### Ephemeral content: refresh or delete, every pass

\`ephemeral\` has **no age threshold and no config key** \u2014 an ephemeral fact is one whose truth expires on its own schedule, which no timer can predict. Every \`integrate\` pass therefore visits all ephemeral-marked content and does one of exactly two things to each item:

- **Refresh** it, if this pass produced evidence that it is still true (restate it in current terms and bump \`updated\`), or
- **Delete** it.

There is no third option. "Leave it and check next time" is what makes a current-focus line quietly describe last quarter's work. Deletion is safe: the store is a git repo, so the line is recoverable and the page history stays intact.

This applies to whole pages marked \`decay: ephemeral\` and to ephemeral fields inside otherwise stable pages \u2014 the canonical one being the current-focus line in \`project.md\`.

## Index Lines

\`index.md\` carries exactly one line per page, in this format:

\`\`\`
- [[deploy-process]] \u2014 staging via GitHub Actions, prod is manual
\`\`\`

The \`[[slug]]\` matches the page filename (\`pages/deploy-process.md\`) and is how the tooling associates an index line with its page \u2014 the decay pass moves and demotes index lines by finding that wikilink. Keep the format exact: leading \`- \`, the wikilink, then the summary. The summary text is yours to write.

Lines below a \`## Archive\` heading are pages the mechanical decay pass demoted; leave them there. A page moved into \`archive/\` loses its index line entirely \u2014 it is still greppable, just no longer in the catalog.

## Inbox Entries Are Machine-Formatted

\`inbox.md\` is a normal markdown file you can read and edit, but each captured entry is a **single line** ending in an HTML comment that carries its machine identity:

\`\`\`
- staging deploys need the VPN <!--mehmory id=... src=... host=claude-code ts=...-->
\`\`\`

That trailing comment is invisible when the markdown is rendered and is what lets tooling deduplicate replays and clear exactly the entries an integrate consumed \u2014 including when a capture lands mid-integrate. So:

- Editing or rewording the **text** of an entry is fine.
- **Preserve the trailing comment**, and keep each entry on one line.
- Deleting a whole entry line is fine (it simply never gets integrated).
- Do not hand-write new entries; the id is a hash. Use the remember skill (or slash command, on harnesses that have one), or the \`remember:\` prompt prefix.

Any line that does not match the entry format \u2014 headings, your own notes \u2014 is left alone by every tool.

## Size Caps

Hard limits enforced at write time:

- **identity.md** \u2264 ~200 tokens \u2014 user prefs, tooling, style
- **project.md** \u2264 ~200 tokens \u2014 project summary, current focus
- **index.md** \u2264 ~500 tokens \u2014 catalog of pages, one line per page
- **page** \u2264 ~1500 tokens \u2014 single topic; split if over (pages are not files, facts are)

Token estimation uses chars/4 with \xB120% tolerance.

## House Style

- **Caveman-telegraphic bullets** \u2014 short facts per bullet, more signal per injected token
- **Full prose only where nuance demands** \u2014 avoid elaborate sentences
- **Wikilinks** \u2014 use \`[[page-name]]\` to link between pages (backlinks/orphans are derived, never stored)
- **Scope rule** \u2014 user-level facts (preferences, tooling) \u2192 \`global/\`; codebase facts \u2192 \`projects/<key>/\`

## Secret Filter Limitation

The secret filter is best-effort pattern matching. It catches common forms \u2014 AWS keys, GitHub tokens, bearer tokens, private-key blocks, \`.env\`-shaped secrets, URL-embedded credentials \u2014 but it does **not** reliably catch PII or secrets written in prose. Do not rely on it as your only safeguard against writing sensitive material into memory.

## Frontmatter

Every page carries:

- **updated** (ISO date) \u2014 last edit timestamp
- **type** (string) \u2014 one of: decision, procedure, entity, preference, gotcha
- **refs** (optional, string) \u2014 source references or provenance

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

- \`integrate\` \u2014 merges inbox entries into pages
- \`lint\` \u2014 staleness sweeps, orphan cleanup
- \`onboard\` \u2014 initial inbox seeding
- Session lifecycle \u2014 captures, decay passes

Every commit has a message summarizing the operation and entry count. The full git history is your audit trail.
`;

// src/core/decay.ts
import { join as join2 } from "path";
function lineRefersTo(line, pageFile) {
  return parseIndexLine(line)?.slug === pageFile.replace(/\.md$/, "");
}
function decayPass(scopeDir, options = {}) {
  const empty = { demoted: [], archived: [], rewroteIndex: false };
  return failOpen(
    () => {
      const config = loadConfig();
      if (!config.decay.enabled) return empty;
      const now = options.now ?? Date.now();
      const archiveDays = options.archiveDays ?? config.decay.archive_days;
      const purgeDays = options.purgeDays ?? config.decay.purge_days;
      const pagesDir = join2(scopeDir, "pages");
      const indexPath = join2(scopeDir, "index.md");
      if (!pathExists(pagesDir)) return empty;
      const demoted = [];
      const archived = [];
      const liveOrder = /* @__PURE__ */ new Map();
      for (const name of listDir(pagesDir)) {
        if (!name.endsWith(".md")) continue;
        const pagePath = join2(pagesDir, name);
        if (!stat(pagePath)?.isFile()) continue;
        const contents = readFile(pagePath);
        const fields = readFrontmatter(contents);
        const decayClass = fields["decay"] ?? "default";
        const age = pageAgeDays(contents, now);
        const updatedAt = Date.parse(fields["updated"] ?? "");
        if (decayClass !== "default" || age === null) {
          liveOrder.set(name, Number.isNaN(updatedAt) ? 0 : updatedAt);
          continue;
        }
        if (age > purgeDays) {
          const archiveDir = join2(scopeDir, ARCHIVE_DIR);
          mkdir(archiveDir);
          rename(pagePath, join2(archiveDir, name));
          archived.push(name);
        } else if (age > archiveDays) {
          demoted.push(name);
        } else {
          liveOrder.set(name, Number.isNaN(updatedAt) ? 0 : updatedAt);
        }
      }
      if (!pathExists(indexPath)) {
        return { demoted, archived, rewroteIndex: false };
      }
      const original = readFile(indexPath);
      const rewritten = rewriteIndex(original, liveOrder, demoted, archived);
      if (rewritten === original) return { demoted, archived, rewroteIndex: false };
      atomicWrite(indexPath, rewritten);
      return { demoted, archived, rewroteIndex: true };
    },
    empty,
    "E_ATOMIC_WRITE"
  );
}
function rewriteIndex(contents, liveOrder, demoted, archived) {
  const lines = contents.split("\n");
  const preamble = [];
  const live = [];
  const belowDivider = [];
  const findPage = (line) => {
    for (const name of [...liveOrder.keys(), ...demoted, ...archived]) {
      if (lineRefersTo(line, name)) return name;
    }
    return void 0;
  };
  for (const line of lines) {
    if (line.trim() === ARCHIVE_DIVIDER) continue;
    const page = findPage(line);
    if (page === void 0) {
      preamble.push(line);
      continue;
    }
    if (archived.includes(page)) continue;
    if (demoted.includes(page)) {
      belowDivider.push(line);
      continue;
    }
    live.push({ line, updated: liveOrder.get(page) ?? 0 });
  }
  while (preamble.length > 0 && preamble[preamble.length - 1]?.trim() === "") preamble.pop();
  const out = [...preamble];
  if (live.length > 0) {
    live.sort((a, b) => b.updated - a.updated);
    out.push("", ...live.map((l) => l.line));
  }
  if (belowDivider.length > 0) {
    out.push("", ARCHIVE_DIVIDER, "", ...belowDivider);
  }
  out.push("");
  return out.join("\n");
}

// src/hooks/session-start.ts
var MAX_MAINTENANCE_LINES = 2;
function maintenance(sessionId, project, host, config) {
  const finalized = finalizePendingSessions(sessionId, project, host, config);
  tryProjectLock(project, () => decayPass(scopePaths(project).projectDir));
  for (let claimed = 0; claimed < config.queue.claims_per_start; claimed++) {
    const job = claimJob("distill-final");
    if (!job) break;
    applyDistillJob(job.data, config);
    completeJob(job.id);
  }
  sweepSessionState();
  return finalized;
}
runHook("SessionStart", (input, project, host, config) => {
  if (!config.hooks.session_start.enabled || isPaused(input.session_id)) return {};
  const justInitialized = !storeExists() && initStore().ok;
  const paths = scopePaths(project);
  const injection = buildScopeInjection(project, config);
  const entries = readInboxEntries(paths.inboxFile);
  const bytes = inboxBytes(paths.inboxFile);
  const candidates = [];
  const warning = pendingWarnings()[0];
  if (warning !== void 0) candidates.push(`mehmory: ${warning}`);
  const integrate = skillRef(host, "integrate");
  if (input.source === "compact") {
    candidates.push(
      `mehmory: context was compacted \u2014 what came before is captured in ${paths.inboxFile}; run ${integrate} to merge it`
    );
  }
  if (entries.length >= config.inbox.nudge_entries || bytes >= config.inbox.nudge_bytes) {
    candidates.push(`mehmory: inbox has ${String(entries.length)} entries \u2014 run ${integrate}`);
  }
  if (justInitialized || storeIsUnpopulated(project)) {
    candidates.push(
      `mehmory: memory at ${mehmoryHome()} is empty \u2014 run ${skillRef(host, "onboard-session")} to seed it`
    );
  }
  const lines = candidates.slice(0, MAX_MAINTENANCE_LINES);
  const context = [injection.text, ...lines].filter(Boolean).join("\n");
  const finalized = maintenance(input.session_id, project, host, config);
  return {
    context,
    stats: {
      injected_tokens: estimateTokens(context),
      inbox_bytes: bytes,
      maintenance_lines: lines.length,
      finalized_sessions: finalized
    }
  };
});
