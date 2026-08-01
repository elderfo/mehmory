/**
 * The publish job targets the owner's **GitHub Packages** registry, not npmjs.org.
 * Three things have to agree for a `v*` tag to publish, and nothing in the workflow
 * fails loudly if they drift apart — the publish just lands in the wrong registry or
 * 401s — so they are pinned here:
 *
 *   1. `package.json` is scoped `@elderfo/*`. GitHub Packages rejects a publish whose
 *      scope doesn't match the owning account.
 *   2. `publishConfig.registry` and the workflow's `registry-url` name the same host,
 *      so a local `pnpm publish` and a tagged CI publish land in the same place — and
 *      setup-node pins `scope`, without which `registry-url` redirects every dependency
 *      install in the job at GitHub Packages and breaks `pnpm install`.
 *   3. The job carries `packages: write` and authenticates with `GITHUB_TOKEN`. The
 *      default token can publish this repo's own packages, so no `NPM_TOKEN` secret
 *      exists — and with no secret to test for, the previous version's step-level
 *      `env`-var dance (a workaround for `secrets` being unavailable in a job-level
 *      `if:`) is gone. The job-level `if:` names only the tag ref, which *is* an
 *      allowed context there.
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
const REGISTRY = 'https://npm.pkg.github.com';
const SCOPE = '@elderfo';

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

describe('release workflow — publish-npm targets GitHub Packages', () => {
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

  it('publish-npm has packages: write, without which GITHUB_TOKEN cannot publish', () => {
    const block = jobBlock(source, 'publish-npm');
    expect(block).toMatch(/permissions:\s*\n(?:\s+\w+:\s*\w+\n)*\s*packages:\s*write/);
  });

  it('the publish step authenticates with GITHUB_TOKEN and needs no NPM_TOKEN secret', () => {
    const block = jobBlock(source, 'publish-npm');
    const stepStart = block.indexOf('Publish to GitHub Packages');
    expect(
      stepStart,
      'the "Publish to GitHub Packages" step was not found'
    ).toBeGreaterThan(-1);
    const stepBlock = block.slice(stepStart);

    expect(stepBlock).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    // The NPM_TOKEN secret is gone; a leftover reference means the migration is half
    // applied and the publish would authenticate against the wrong registry.
    expect(block).not.toMatch(/NPM_TOKEN/);
  });

  it("setup-node's registry-url matches package.json's publishConfig.registry", () => {
    const block = jobBlock(source, 'publish-npm');
    expect(block).toContain(`registry-url: '${REGISTRY}'`);

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      name: string;
      publishConfig?: { registry?: string };
    };
    expect(pkg.publishConfig?.registry).toBe(REGISTRY);
    // GitHub Packages rejects a publish whose scope doesn't match the owning account.
    expect(pkg.name.startsWith(`${SCOPE}/`)).toBe(true);
  });

  it("setup-node pins the scope, so registry-url doesn't redirect dependency installs", () => {
    const block = jobBlock(source, 'publish-npm');
    // Without `scope`, setup-node writes a bare `registry=` line and every dependency
    // resolves against GitHub Packages — the `pnpm install` in this same job then fails
    // on packages that only exist on npmjs. This is the regression guard for that.
    expect(block).toContain(`scope: '${SCOPE}'`);
    expect(block).toMatch(/pnpm install --frozen-lockfile/);
  });
});
