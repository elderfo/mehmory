/**
 * Releases are cut by merging a VERSION bump to `main`. The workflow runs after a green
 * `CI` run of a push to `main`: `tag-release` creates the tag and the GitHub Release, and
 * `publish-npm` publishes the tagged tree to **npmjs.org**. Two contracts are pinned here.
 *
 * Release ownership. Only a green CI run can release, so the trigger is `workflow_run` on
 * `CI` for `main` and no `push: tags` trigger remains: a hand-pushed tag must not publish
 * on its own. `contents: write` exists on `tag-release` alone, with nothing granted at the
 * top level. Tags are never moved, so no force flag appears anywhere.
 *
 * The npm publish. Three things have to agree, and nothing in the workflow fails loudly
 * if they drift apart — the publish just lands in the wrong registry or 401s:
 *
 *   1. `package.json` is unscoped. The install path a public reader follows is
 *      `npm install -g mehmory` with no registry configuration and no token; a scope
 *      reintroduced here would silently change that contract.
 *   2. `publishConfig.registry` and the workflow's `registry-url` name the same host,
 *      so a local `pnpm publish` and a CI publish land in the same place.
 *   3. The publish step authenticates with the `NPM_TOKEN` secret. `publish-npm`'s `if:`
 *      never references `secrets` — it is not an allowed context there, and a previous
 *      version of this workflow regressed on exactly that.
 *
 * The GitHub Packages assertions this file used to carry are inverted rather than
 * deleted: `@elderfo/mehmory` on `npm.pkg.github.com` needed a `read:packages` token
 * from every installer, which is untenable for a public repo. Any reappearance of that
 * registry, that scope, or the `packages: write` permission means the migration is
 * half-reverted, so each is asserted absent.
 *
 * No YAML library is added for this (out of scope — this workflow's structure is small,
 * fixed, and hand-authored, not generated). The helper below isolates a job's own block
 * by indentation, which is all these assertions need.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflowPath = join(process.cwd(), '.github', 'workflows', 'release.yml');
const packageJsonPath = join(process.cwd(), 'package.json');
const REGISTRY = 'https://registry.npmjs.org';
const LEGACY_REGISTRY = 'https://npm.pkg.github.com';
const LEGACY_SCOPE = '@elderfo';

function loadWorkflow(): string {
  return readFileSync(workflowPath, 'utf-8');
}

function indentOf(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

/** Isolate a top-level job's own block: everything more indented than the `<job>:`
 * line, up to (not including) the next line at or above that indentation. */
function jobBlock(source: string, jobName: string): string {
  const lines = source.split('\n');
  const startIndex = lines.findIndex(line => line.trim() === `${jobName}:`);
  if (startIndex === -1) {
    throw new Error(`job "${jobName}" not found in ${workflowPath}`);
  }
  const startLine = lines[startIndex] ?? '';
  const startIndent = indentOf(startLine);

  const block: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    const indent = indentOf(line);
    if (indent <= startIndent) break;
    block.push(line);
  }
  return block.join('\n');
}

/** The job-level `if:` line of a job block, if it has one. */
function jobIf(block: string): string | undefined {
  return block.split('\n').find(line => /^\s{4}if:/.test(line));
}

describe('release workflow — publish-npm targets npmjs', () => {
  const source = loadWorkflow();

  it('no longer force-adds hook bundles onto the tag — they ship on the branch', () => {
    // Inverted rather than deleted, same as the GitHub Packages assertions above. The
    // force-add job built `hooks/*.mjs`, committed them onto the `v*` tag and force-pushed
    // it. The tag was correct and irrelevant: the marketplace clones the default branch,
    // so the bundles never reached an install. They are committed on `main` now (A25),
    // and the tag inherits them. A reappearance of this job means the outage is back.
    expect(source).not.toMatch(/git add -f hooks/);
    expect(source).not.toMatch(/--force/);
    expect(source).not.toContain('build-tag');
  });

  it('releases only after CI on main, never from a hand-pushed tag', () => {
    // jobBlock isolates any key's block by indentation, top-level `on:` included.
    const on = jobBlock(source, 'on');
    expect(on).toMatch(/workflow_run:\s*\n\s*workflows:\s*\[CI\]/);
    expect(on).toMatch(/types:\s*\[completed\]/);
    expect(on).toMatch(/branches:\s*\[main\]/);
    expect(source).not.toMatch(/^\s*push:/m);
    expect(source).not.toMatch(/^\s*tags:/m);
  });

  it('grants nothing at the top level and contents: write to tag-release alone', () => {
    expect(source).toMatch(/^permissions: \{\}$/m);
    expect(source.match(/contents:\s*write/g)).toHaveLength(1);
    expect(jobBlock(source, 'tag-release')).toMatch(/permissions:\s*\n\s*contents:\s*write/);
    expect(jobBlock(source, 'publish-npm')).not.toMatch(/contents:\s*write/);
  });

  it("tag-release's job-level if: requires a successful CI run", () => {
    const jobIfLine = jobIf(jobBlock(source, 'tag-release'));
    expect(jobIfLine, 'tag-release must declare a job-level if:').toBeDefined();
    expect(jobIfLine).toMatch(/github\.event\.workflow_run\.conclusion == 'success'/);
  });

  it('publish-npm needs tag-release, and its if: (if any) never references secrets', () => {
    const block = jobBlock(source, 'publish-npm');
    expect(block).toMatch(/^\s{4}needs:\s*tag-release\s*$/m);
    // The one line the previous regression got wrong: `secrets` is not in the
    // context list GitHub allows inside jobs.<job_id>.if.
    expect(jobIf(block) ?? '').not.toMatch(/secrets\./);
  });

  it('never moves a tag: no force flag anywhere', () => {
    // `--force` is already asserted absent by the hook-bundle test above.
    expect(source).not.toMatch(/git push\b.*\s-f\b/);
    expect(source).not.toMatch(/git tag\b.*\s-f\b/);
  });

  it('publish-npm needs no packages: write — nothing is published to GitHub Packages', () => {
    const block = jobBlock(source, 'publish-npm');
    expect(block).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(block).not.toMatch(/packages:\s*write/);
  });

  it('the publish step authenticates with the NPM_TOKEN secret', () => {
    const block = jobBlock(source, 'publish-npm');
    const stepStart = block.indexOf('Publish to npmjs');
    expect(stepStart, 'the "Publish to npmjs" step was not found').toBeGreaterThan(-1);
    const stepBlock = block.slice(stepStart);

    expect(stepBlock).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    // GITHUB_TOKEN cannot publish to npmjs. A leftover reference means the migration is
    // half applied and the publish would authenticate against the wrong registry.
    expect(stepBlock).not.toMatch(/secrets\.GITHUB_TOKEN/);
  });

  it('publish-npm caches nothing, so a skipped install cannot fail the cache save', () => {
    // The first run on main skipped the publish (0.4.0 was already on npm), so pnpm never
    // created its store, and setup-node's post step failed the job saving a missing path.
    expect(jobBlock(source, 'publish-npm')).not.toMatch(/^\s*cache:/m);
  });

  it("setup-node's registry-url matches package.json's publishConfig.registry", () => {
    const block = jobBlock(source, 'publish-npm');
    expect(block).toContain(`registry-url: '${REGISTRY}'`);

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      name: string;
      publishConfig?: { registry?: string };
    };
    expect(pkg.publishConfig?.registry).toBe(REGISTRY);
  });

  it('the package stays unscoped, so `npm install -g mehmory` needs no registry config', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name: string };
    expect(pkg.name).toBe('mehmory');
    expect(pkg.name.startsWith('@')).toBe(false);
  });

  it('no GitHub Packages registry or scope survives anywhere in the workflow', () => {
    // The whole reason for the move: npm.pkg.github.com has no anonymous read, so any
    // reappearance of it puts a token back between a reader and `npm install`.
    expect(source).not.toContain(LEGACY_REGISTRY);
    expect(source).not.toContain(LEGACY_SCOPE);
  });
});
