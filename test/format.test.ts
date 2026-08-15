import { describe, it, expect } from 'vitest';
import {
  FORMAT_VERSION,
  PAGE_TYPES,
  DECAY_CLASSES,
  FRONTMATTER_KEYS,
  FRONTMATTER_DIVIDER,
  USER_ERROR_TEMPLATE,
  formatIndexLine,
  parseIndexLine,
} from '../src/schema/format.js';

describe('format constants', () => {
  it('exports FORMAT_VERSION = 3', () => {
    expect(FORMAT_VERSION).toBe(3);
  });

  it('exports PAGE_TYPES enumeration', () => {
    expect(PAGE_TYPES).toContain('decision');
    expect(PAGE_TYPES).toContain('procedure');
    expect(PAGE_TYPES).toContain('entity');
    expect(PAGE_TYPES).toContain('preference');
    expect(PAGE_TYPES).toContain('gotcha');
    expect(PAGE_TYPES.length).toBe(5);
  });

  it('exports DECAY_CLASSES enumeration matching the spec gate outcome', () => {
    // The spec's 2026-07-28 gate fixes these three names; they are parsed from
    // page frontmatter by run 2, so drifting from the spec breaks integrate.
    expect([...DECAY_CLASSES]).toEqual(['evergreen', 'ephemeral', 'default']);
  });

  it('exports FRONTMATTER_KEYS', () => {
    expect(FRONTMATTER_KEYS.updated).toBe('updated');
    expect(FRONTMATTER_KEYS.type).toBe('type');
    expect(FRONTMATTER_KEYS.refs).toBe('refs');
    expect(FRONTMATTER_KEYS.decay).toBe('decay');
    expect(FRONTMATTER_KEYS.schema_version).toBe('schema_version');
  });

  it('exports FRONTMATTER_DIVIDER', () => {
    expect(FRONTMATTER_DIVIDER).toBe('---');
  });
});

describe('USER_ERROR_TEMPLATE', () => {
  it('renders actionable error with Fix clause', () => {
    const text = USER_ERROR_TEMPLATE(
      'E_CONFIG_PARSE',
      'config.json is not valid JSON (line 4)',
      'Memory is running on defaults, so your settings are not applied',
      true,
      '$EDITOR ~/.mehmory/config.json',
      '~/.mehmory/.state/errors.log'
    );

    expect(text).toContain('MEHMORY E_CONFIG_PARSE:');
    expect(text).toContain('config.json is not valid JSON (line 4)');
    expect(text).toContain('Memory is running on defaults');
    expect(text).toContain('Fix: $EDITOR ~/.mehmory/config.json.');
    expect(text).toContain('Details: ~/.mehmory/.state/errors.log');
  });

  it('renders informational error without Fix clause', () => {
    const text = USER_ERROR_TEMPLATE(
      'E_LOCK_TIMEOUT',
      'project lock held for over 5s; proceeded without it',
      'A concurrent session may have overwritten an index rewrite',
      false,
      undefined,
      '~/.mehmory/.state/errors.log'
    );

    expect(text).toContain('MEHMORY E_LOCK_TIMEOUT:');
    expect(text).toContain('project lock held for over 5s');
    expect(text).not.toContain('Fix:');
    expect(text).toContain('Details: ~/.mehmory/.state/errors.log');
  });

  it('uses default details path when not provided', () => {
    const text = USER_ERROR_TEMPLATE(
      'E_TEST',
      'test error',
      'test consequence',
      false
    );

    expect(text).toContain('Details: ~/.mehmory/.state/errors.log');
  });

  it('omits Fix clause for informational even when fix is provided', () => {
    const text = USER_ERROR_TEMPLATE(
      'E_DISTILL_LOSSY',
      '34% of transcript lines were unreadable',
      'That portion of the session was not captured',
      false,
      'rm something',
      '~/.mehmory/.state/errors.log'
    );

    expect(text).not.toContain('Fix:');
    expect(text).not.toContain('rm something');
  });
});

/** Run-2 amendment 26, promoted from decay.ts's heuristic to a format constant. */
describe('index line format', () => {
  it('round-trips slug and summary', () => {
    const line = formatIndexLine('deploy-process', 'staging via GitHub Actions');
    expect(line).toBe('- [[deploy-process]] — staging via GitHub Actions');
    expect(parseIndexLine(line)).toEqual({
      slug: 'deploy-process',
      summary: 'staging via GitHub Actions',
    });
  });

  it('parses a line that carries no summary', () => {
    expect(parseIndexLine('- [[deploy-process]]')?.slug).toBe('deploy-process');
  });

  it('rejects prose that merely names a page', () => {
    expect(parseIndexLine('The deploy-process page covers staging.')).toBeUndefined();
    expect(parseIndexLine('## Archive')).toBeUndefined();
    expect(parseIndexLine('')).toBeUndefined();
  });
});
