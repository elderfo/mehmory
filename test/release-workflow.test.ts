/**
 * The publish job targets **npmjs.org**. Three things have to agree for a `v*` tag to
 * publish, and nothing in the workflow fails loudly if they drift apart — the publish
 * just lands in the wrong registry or 401s — so they are pinned here:
 *
 *   1. `package.json` is unscoped. The install path a public reader follows is
 *      `npm install -g mehmory` with no registry configuration and no token; a scope
 *      reintroduced here would silently change that contract.
 *   2. `publishConfig.registry` and the workflow's `registry-url` name the same host,
 *      so a local `pnpm publish` and a tagged CI publish land in the same place.
 *   3. The publish step authenticates with the `NPM_TOKEN` secret. The job-level `if:`
 *      names only the tag ref — `secrets` is not an allowed context there, and a
 *      previous version of this workflow regressed on exactly that.
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

describe('release workflow — publish-npm targets npmjs', () => {
  const source = loadWorkflow();

  it('build-tag exists and force-adds the built hook bundles into the tagged tree', () => {
    const block = jobBlock(source, 'build-tag');
    expect(block).toMatch(/git add -f hooks\/\*\.mjs/);
    expect(block).toMatch(/git push origin "\$GITHUB_REF_NAME" --force/);
  });

  it('build-tag has contents: write permission for its force-push', () => {
    const block = jobBlock(source, 'build-tag');
    expect(block).toMatch(/permissions:\s*\n\s*contents:\s*write/);
  });

  it("publish-npm's job-level if: names the tag ref and never references secrets", () => {
    const block = jobBlock(source, 'publish-npm');
    const jobIfLine = block.split('\n').find(line => /^\s{4}if:/.test(line));
    expect(jobIfLine, 'publish-npm must declare a job-level if:').toBeDefined();
    expect(jobIfLine).toMatch(/startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
    // The one line the previous regression got wrong: `secrets` is not in the
    // context list GitHub allows inside jobs.<job_id>.if.
    expect(jobIfLine).not.toMatch(/secrets\./);
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
