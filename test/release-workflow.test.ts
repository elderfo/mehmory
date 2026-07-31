/**
 * Criterion 18: the npm publish job must be **inert** — gated on both a `v*` tag and
 * `secrets.NPM_TOKEN`, neither of which exist yet — without breaking the workflow's
 * ability to load at all.
 *
 * GitHub does not provide the `secrets` context inside a job-level `if:` — only
 * `github`, `needs`, `vars` and `inputs` are available there (confirmed against
 * GitHub's context-availability documentation:
 * https://docs.github.com/en/actions/learn-github-actions/contexts). A job-level
 * `if: ... && secrets.NPM_TOKEN != ''` doesn't skip the job; it fails the whole
 * workflow to parse, taking `build-tag` — the fix for BLOCKER 2 — down with it. So this
 * test pins the actual GitHub-accepted shape: the job-level `if:` names only the tag
 * ref, and the token check lives in a step-level `if:` reading an `env` var that step's
 * own `env:` block populates from the secret (`env` *is* available in a step-level
 * `if:`; `secrets` still is not).
 *
 * No YAML library is added for this (out of scope — package.json is unit L's file, and
 * this workflow's structure is small, fixed, and hand-authored, not generated). The
 * helper below isolates a job's own block by indentation, which is all these
 * assertions need.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflowPath = join(process.cwd(), '.github', 'workflows', 'release.yml');

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

describe('release workflow — publish-npm stays inert without breaking build-tag', () => {
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

  it('the publish step itself is gated on a step-level if: reading an env var populated from the secret', () => {
    const block = jobBlock(source, 'publish-npm');
    const stepStart = block.indexOf('Publish to npm');
    expect(stepStart, 'the "Publish to npm" step was not found').toBeGreaterThan(-1);
    const stepBlock = block.slice(stepStart);

    expect(stepBlock).toMatch(/if:\s*env\.NPM_TOKEN\s*!=\s*['"]{2}/);
    expect(stepBlock).toMatch(/NPM_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
  });
});
