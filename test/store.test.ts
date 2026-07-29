/**
 * Tests for store initialization (done-when 14, 16, 19).
 * Verifies: directory structure, idempotency, crash recovery, user edit preservation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { initStore } from '../src/core/store.js';
import { mehmoryHome } from '../src/core/home.js';
import { pathExists, readFile, mkdir, atomicWrite, listDir } from '../src/core/fs.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

// Note: test/setup.ts already guards MEHMORY_HOME to prevent touching ~/.mehmory

describe('initStore', () => {
  let testHome: string;

  beforeEach(() => {
    // Create a fresh temp directory for each test
    testHome = createTempDir('mehmory-store-test');
    process.env.MEHMORY_HOME = testHome;
  });

  afterEach(() => {
    // Clean up
    cleanupTempDir(testHome);
  });

  it('creates directory structure on first run', () => {
    const result = initStore();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('initStore failed');

    const home = mehmoryHome();
    expect(home).toBe(testHome);

    // Verify directory structure exists
    expect(pathExists(join(home, 'global'))).toBe(true);
    expect(pathExists(join(home, 'global', 'pages'))).toBe(true);
    expect(pathExists(join(home, 'projects'))).toBe(true);
    expect(pathExists(join(home, '.state'))).toBe(true);
    expect(pathExists(join(home, '.git'))).toBe(true);
  });

  it('creates initial files in global/', () => {
    initStore();

    const home = mehmoryHome();
    expect(pathExists(join(home, 'global', 'identity.md'))).toBe(true);
    expect(pathExists(join(home, 'global', 'index.md'))).toBe(true);
    expect(pathExists(join(home, 'global', 'log.md'))).toBe(true);
    expect(pathExists(join(home, 'global', 'inbox.md'))).toBe(true);
  });

  it('copies SCHEMA.md to root', () => {
    initStore();

    const home = mehmoryHome();
    const schemaPath = join(home, 'SCHEMA.md');
    expect(pathExists(schemaPath)).toBe(true);

    const content = readFile(schemaPath);
    expect(content).toContain('schema_version: "1"');
    expect(content).toContain('user-editable guidance');
  });

  it('includes secret filter limitation in SCHEMA.md', () => {
    initStore();

    const home = mehmoryHome();
    const schemaPath = join(home, 'SCHEMA.md');
    const content = readFile(schemaPath);

    expect(content).toContain(
      'The secret filter is best-effort pattern matching'
    );
    expect(content).toContain(
      'does **not** reliably catch PII or secrets written in prose'
    );
  });

  it('is idempotent: running twice succeeds with no duplication', () => {
    // First run
    const result1 = initStore();
    expect(result1.ok).toBe(true);

    const home = mehmoryHome();
    const globalDir = join(home, 'global');

    // Count files after first run
    const filesAfterFirstRun = listDir(globalDir).filter(
      (f) => f.endsWith('.md') || f === 'pages'
    ).length;

    // Second run
    const result2 = initStore();
    expect(result2.ok).toBe(true);

    // Count files after second run (should be identical)
    const filesAfterSecondRun = listDir(globalDir).filter(
      (f) => f.endsWith('.md') || f === 'pages'
    ).length;

    expect(filesAfterFirstRun).toBe(filesAfterSecondRun);

    // Verify file contents are identical
    const identity1 = readFile(join(globalDir, 'identity.md'));
    const inbox1 = readFile(join(globalDir, 'inbox.md'));

    initStore(); // Run again

    const identity2 = readFile(join(globalDir, 'identity.md'));
    const inbox2 = readFile(join(globalDir, 'inbox.md'));

    expect(identity1).toBe(identity2);
    expect(inbox1).toBe(inbox2);
  });

  it('recovers from half-initialized store (missing .git)', () => {
    const home = mehmoryHome();

    // Manually create directory structure without git
    mkdir(join(home, 'global', 'pages'));
    mkdir(join(home, 'projects'));
    mkdir(join(home, '.state'));

    atomicWrite(join(home, 'global', 'identity.md'), '---\ntype: preference\n---\n# Identity\n');
    atomicWrite(join(home, 'SCHEMA.md'), '---\nschema_version: "1"\n---\n# Schema\n');

    // Verify .git doesn't exist
    expect(pathExists(join(home, '.git'))).toBe(false);

    // Run initStore to complete initialization
    const result = initStore();
    expect(result.ok).toBe(true);

    // Verify .git now exists
    expect(pathExists(join(home, '.git'))).toBe(true);

    // Verify original files are preserved
    const identity = readFile(join(home, 'global', 'identity.md'));
    expect(identity).toContain('# Identity');
  });

  it('recovers from half-initialized store (missing layout)', () => {
    const home = mehmoryHome();

    // Manually create git repository only
    mkdir(home);
    // Create .git directory manually to simulate git init
    mkdir(join(home, '.git'));

    // Verify layout directories don't exist
    expect(pathExists(join(home, 'global'))).toBe(false);
    expect(pathExists(join(home, '.state'))).toBe(false);

    // Run initStore to complete initialization
    const result = initStore();
    expect(result.ok).toBe(true);

    // Verify directories now exist
    expect(pathExists(join(home, 'global'))).toBe(true);
    expect(pathExists(join(home, '.state'))).toBe(true);
    expect(pathExists(join(home, 'global', 'identity.md'))).toBe(true);
  });

  it('preserves user-modified SCHEMA.md', () => {
    const home = mehmoryHome();
    initStore();

    // User edits SCHEMA.md
    const schemaPath = join(home, 'SCHEMA.md');
    const userEdit = `---
schema_version: "1"
---

# My Custom Schema

This is my edited version.
`;
    atomicWrite(schemaPath, userEdit);

    // Run initStore again
    initStore();

    // User's edits should be preserved
    const content = readFile(schemaPath);
    expect(content).toContain('My Custom Schema');
    expect(content).toContain("This is my edited version.");
  });

  it('preserves user-modified global files', () => {
    const home = mehmoryHome();
    initStore();

    // User edits identity.md
    const identityPath = join(home, 'global', 'identity.md');
    const userEdit = `---
type: preference
---

# My Identity

Custom user preferences go here.
`;
    atomicWrite(identityPath, userEdit);

    // Run initStore again
    initStore();

    // User's edits should be preserved
    const content = readFile(identityPath);
    expect(content).toContain('My Identity');
    expect(content).toContain('Custom user preferences');
  });

  it('does not write to real ~/.mehmory during tests (done-when 16 guard)', () => {
    // Verify MEHMORY_HOME is set to temp directory
    const home = mehmoryHome();
    expect(home).not.toMatch(/^[\w\d_-]*\.mehmory$/);
    expect(home).toContain('mehmory-store-test-');

    // Run initStore
    initStore();

    // Verify nothing was written to the real ~/.mehmory
    // (This test passes implicitly if the guard is working)
    expect(home).toBe(testHome);
  });

  it('returns correct signature with ok: true on success', () => {
    const result = initStore();

    // Verify result has the correct shape
    expect(result).toHaveProperty('ok');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result).toHaveProperty('home');
      expect(result.home).toBe(mehmoryHome());
      expect(result).not.toHaveProperty('error');
    }
  });

  it('initializes files with default content when created fresh', () => {
    initStore();

    const home = mehmoryHome();
    const identity = readFile(join(home, 'global', 'identity.md'));
    const index = readFile(join(home, 'global', 'index.md'));
    const log = readFile(join(home, 'global', 'log.md'));
    const inbox = readFile(join(home, 'global', 'inbox.md'));

    // All files should have content
    expect(identity.length).toBeGreaterThan(0);
    expect(index.length).toBeGreaterThan(0);
    expect(log.length).toBeGreaterThan(0);
    expect(inbox.length).toBeGreaterThan(0);

    // Files should have frontmatter
    expect(identity).toContain('---');
    expect(identity).toContain('type:');
    expect(index).toContain('---');
    expect(log).toContain('---');
    expect(inbox).toContain('---');
  });
});

describe('SCHEMA.md / SCHEMA_TEMPLATE drift', () => {
  it('ships the same schema text in assets/ and in the initializer', () => {
    // store.ts embeds the schema as a template literal so a bundled hook has no
    // runtime asset dependency, but criterion 14 also requires assets/SCHEMA.md
    // to exist as editorial content. Nothing reads the asset at runtime, so the
    // two copies can drift silently — and already did once (the decay class names
    // had to be corrected in both files by hand). This pins them together, so
    // drift fails at commit time instead of shipping.
    const home = mehmoryHome();
    initStore();

    const written = readFileSync(join(home, 'SCHEMA.md'), 'utf-8');
    const asset = readFileSync(
      join(process.cwd(), 'assets', 'SCHEMA.md'),
      'utf-8'
    );

    expect(written).toBe(asset);
  });
});
