# CEO review: strategic blind spots in mehmory

## The plan has not established that this problem deserves a product

The spec lists six problems as facts, but supplies no evidence about their frequency, cost, or severity. “Session amnesia,” “re-derivation waste,” and “compaction data loss” sound intuitively bad; that does not establish that they are the binding constraint on a solo developer’s productivity. The likely alternatives are cheaper:

- a maintained `CLAUDE.md`;
- a short end-of-session checkpoint;
- git history, issues, or a project log;
- starting fresh and letting the agent inspect the current repository;
- the harness’s own evolving memory features.

The comparison that matters is not “memory versus no memory.” It is mehmory versus a 30-line convention that records current state, decisions, and open loops. Until dogfooding shows repeated, material failures of that convention, the design is automating an assumed pain.

## Persistence is being mistaken for useful recall

The architecture is strongest at proving that text survived. That is not the user outcome. Useful memory requires the right fact to be:

1. captured;
2. represented accurately;
3. kept current;
4. retrieved at the right moment;
5. actually read and applied by the model;
6. more helpful than re-deriving it from live code.

The spec heavily engineers step 1, lightly specifies steps 2–3, and substitutes “inject a file pointer” for steps 4–5. A pointer offered is not a memory recalled. A fact present in markdown is not continuity. The design could reach every mechanical KPI while providing no net value.

The strategic center should be recall precision and avoided rework, not capture survival and storage hygiene.

## The product creates the maintenance work it claims to remove

The system accumulates an inbox, nudges the user to run an integration command, asks the model to editorialize facts into pages, requires lint passes, and exposes doctor/status/stats commands. That is a second knowledge-management system. The user must now wonder:

- Is the inbox backed up?
- Has it been integrated?
- Did integration overwrite a nuance?
- Is the wiki stale?
- Should lint run?
- Did a page get archived?
- Is the hook healthy?

“Visible token cost” does not make the cost disappear. It turns an invisible automation cost into a recurring interruption. The manual integration loop is especially backwards for a tool whose promise is continuity without re-derivation. If the developer has to remember to maintain the memory system, it has failed at its own job.

## The same fallible model is author, editor, fact-checker, and consumer

“Compiled knowledge” removes the raw context that would let a future model distinguish an explicit user decision from an inference, a temporary workaround, or a hallucination. Editorial supersession does not resolve contradiction; it selects a winner, possibly incorrectly, and destroys visible ambiguity in the primary view.

Git history provides rollback only if the user notices the error and can identify the correct earlier state. Most memory failures will be silent: an overgeneralized preference, an obsolete constraint, or a plausible but false causal story. Those are more dangerous than missing memory because they bias future work with confidence.

Source-session references are mentioned for onboarding but are not a first-class property of every durable fact. Without provenance, confidence, scope, and “observed versus inferred” distinctions, the wiki will launder guesses into facts.

## The recall mechanism is designed around implementation convenience

Keyword/FTS matching over titles and headings is cheap, but the product premise depends on recalling things when the user uses different language months later. “Pointers only” further assumes the model will recognize the pointer’s relevance, spend a tool call opening it, and have permission to read a home-directory path. The five-minute Jaccard cache assumes lexical topic stability just when conversations often shift through synonyms, abstractions, and debugging hypotheses.

Rejecting semantic retrieval may be correct for v1, but the spec acts as if lexical retrieval is sufficient rather than a hypothesis to falsify. If precision is poor, prompt hooks become background noise. If recall is poor, the stored wiki is inert. Either outcome invalidates the product regardless of how boring and reliable the storage is.

## The capture strategy optimizes recall at the cost of pollution

User messages, correction patterns, decision markers, and error-resolution pairs are not synonymous with durable knowledge. They include abandoned hypotheses, situational instructions, pasted third-party content, temporary workarounds, and statements later contradicted in the same session. Deterministic extraction can identify shapes, not meaning.

The “both layers” decision doubles capture paths before either path is shown to produce valuable material. It also creates an asymmetric failure mode: false positives accumulate indefinitely, while false negatives are invisible. A system that never deletes and aggressively captures will trend toward a comprehensive record of yesterday’s noise.

## The 60/90-day decay policy is arbitrary and hostile to the most valuable memories

Age is not a proxy for irrelevance. Architectural decisions, release procedures, obscure production gotchas, and personal preferences may be used twice a year and be precisely the facts worth remembering. Meanwhile, “current focus” can become false in a day.

Page-level `updated` timestamps make this worse: touching one bullet can refresh stale neighbors. Moving pages based on age changes retrieval visibility without evidence about use, validity, or importance. Six months from now, fixed-day decay will look like premature machinery built around a metric that never represented value.

## The storage boundary conflicts with how projects actually move

Path hashes treat a checkout location as project identity. Renames, clones, worktrees, alternate machines, and monorepo subdirectories can fork one project’s memory into unrelated islands. A single home-directory git repository also mixes unrelated projects and personal identity into one retention and backup boundary.

This is not merely an implementation edge case. It undermines the product’s promise that knowledge follows the work. Repo-local storage was dismissed too quickly; a hybrid of project-owned durable decisions plus a small user-owned preference file maps better to portability, reviewability, and project lifecycle.

## “Human-readable and git-backed” does not solve trust or privacy

A regex cannot reliably identify secrets or PII in arbitrary transcripts. It will miss proprietary URLs, customer data, credentials without recognizable prefixes, private conversations, source fragments, and sensitive facts expressed in prose. Auto-committing makes accidental capture more durable, not safer. “Nothing is deleted, ever” directly conflicts with user control, data minimization, and the ability to purge compromised material.

Mining up to 30 historical sessions and 500 KB during onboarding creates the highest-risk data operation in the product before the user has learned what will be retained. Human readability is useful only if the user audits the corpus; the design provides no reason to believe a solo developer will routinely review hundreds of generated bullets.

The trust premise is therefore assumed: inspectability is being treated as inspection, and reversibility as correction.

## The v1 scope is a toolbox, not a test of the thesis

Five hooks, a plugin, a bundled CLI, onboarding, FTS5, two tokenizers, lazy indexing, integration, lint, remember, doctor, status, stats, decay, git automation, schema evolution, instrumentation, transcript parsing, and a secret filter are all included before the core behavior is proven.

Several of these features measure or repair complexity introduced by other features:

- doctor exists because the hook-and-repository system can drift;
- lint exists because model-maintained pages become stale or contradictory;
- stats exists because five lifecycle hooks need observability;
- decay exists because indiscriminate capture grows the corpus;
- onboarding exists to manufacture an immediate corpus before organic usefulness is demonstrated.

For a solo “meh-tier” tool, this is strategically inverted. Boring technology does not make a broad product surface cheap to own. Every Claude Code hook or plugin change becomes maintenance across five interception points.

The most foolish six-month scope decisions are likely to be FTS indexing, wiki links, lint, stats, age-based decay, auto-git commits, and transcript-mining onboarding before a single minimal continuity loop proves habitual value.

## The plan is exposed to platform substitution

The tool is entirely coupled to Claude Code transcript formats, lifecycle hooks, plugin packaging, stop semantics, compaction behavior, and model compliance with file pointers. Any native improvement to project memory, compaction, session summaries, or plugin APIs can erase the value proposition or force maintenance.

“Adapter seam later” does not mitigate this. The design’s semantics are Claude-specific, not merely its I/O. A personal tool can accept platform dependence, but then it should minimize the coupled surface and recovery burden. This plan does the opposite.

The relevant competition is not other memory plugins. It is the host adding a good-enough native feature and the developer deciding that another hook is not worth debugging.

## The KPIs are non-falsifiable or measure the machinery

“Works,” “~0,” and “removing it feels noticeably worse” are not targets. Seeded recall tests measure whether the system can retrieve answers chosen to fit its representation. Contradiction counts after model-driven lint measure internal consistency, not truth. Hook latency, token caps, inbox volume, and integrate cadence establish operational health, not developer benefit.

The spec has no baseline and no counterfactual. It does not measure:

- wrong memories acted upon;
- useful recalls divided by pointers offered;
- tasks where recall avoided repository exploration;
- minutes saved minus integration and maintenance time;
- repeated corrections caused by stale memory;
- whether a plain checkpoint file performs as well;
- whether the model would have derived a better answer from current code.

Without those measures, dogfooding will confirm that the system runs and subjective attachment will be mistaken for product validation.

## The 10x reframing is continuity, not memory

The high-value job is probably narrower: “When I resume work, restore the active state and the few durable constraints that are not obvious from the repository.” That suggests a continuity checkpoint, not a personal wiki.

A strategically coherent first version would maintain only:

- current objective and next action;
- unresolved questions and blockers;
- explicit decisions with rationale and source;
- user corrections that have recurred;
- non-obvious procedures not encoded in the repository.

It would update one bounded project file at compaction/end, inject it at start, and deliberately forget everything else. No historical transcript mining, graph, FTS, archive, lint, stats dashboard, or general-purpose knowledge base. The repository remains the source of truth for code facts; mehmory stores only the delta the repository cannot express.

That reframing attacks the expensive transition between sessions, makes the output auditable in one screen, limits privacy exposure, and produces a direct comparison against a hand-written checkpoint. If that primitive does not feel indispensable after several weeks, the larger wiki will not rescue the thesis.

## Decisions required before implementation

1. Define one costly, repeated failure that a plain `CLAUDE.md` or session checkpoint cannot solve.
2. Run a baseline for several real sessions and record restart time, repeated corrections, and wrong assumptions.
3. Test one bounded checkpoint file with no retrieval system.
4. Require every durable fact to carry provenance and distinguish explicit decisions from model inference.
5. Make deletion and project-level purge first-class; abandon “nothing is deleted, ever.”
6. Replace age-based decay with explicit validity and use signals, or omit decay entirely.
7. Choose stable project identity before path-hashed storage.
8. Prove that automatic recall helps more often than it distracts before building onboarding, lint, FTS, stats, or wiki graph features.
9. Set a kill criterion: if the minimal version does not measurably reduce restart/re-derivation time net of maintenance after a fixed dogfood period, stop.

