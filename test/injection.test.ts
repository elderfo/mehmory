import { describe, it, expect } from 'vitest';
import {
  buildInjection,
  type InjectionPart,
} from '../src/core/injection.js';
import { estimateTokens, INJECTION_BUDGET_TOKENS } from '../src/core/tokens.js';
import { ROUTING_BLOCK } from '../src/core/capture.js';

/**
 * Ceiling for the static routing block. It is fixed overhead on every session with a
 * populated store, paid outside `injection.budget_tokens` — so it gets the same
 * treatment every other always-on channel gets: a number, enforced, raised only on
 * purpose. A tenth of the memory budget is the most a set of routing rules is worth.
 */
const ROUTING_BUDGET_TOKENS = INJECTION_BUDGET_TOKENS / 10;

describe('routing block', () => {
  it('stays inside its always-on budget', () => {
    expect(estimateTokens(ROUTING_BLOCK)).toBeLessThanOrEqual(ROUTING_BUDGET_TOKENS);
  });

  it('is self-delimiting and declares itself instructions, not data', () => {
    // The memory frame is explicitly data-only; these lines are the opposite, and the
    // model can only tell them apart if the boundary is unambiguous.
    expect(ROUTING_BLOCK.startsWith('<mehmory-routing>')).toBe(true);
    expect(ROUTING_BLOCK.trimEnd().endsWith('</mehmory-routing>')).toBe(true);
    expect(ROUTING_BLOCK).toContain('Instructions');
  });
});

describe('buildInjection', () => {
  describe('truncation: priority order', () => {
    it('truncates index detail first when all three are oversized', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'a'.repeat(800) }, // 200 tokens
        { label: 'project', content: 'b'.repeat(800) }, // 200 tokens
        { label: 'index', content: 'c'.repeat(2400) }, // 600 tokens (oversized)
      ];

      const frame = buildInjection(parts);

      // Total would be 1000 tokens without truncation; should truncate index first
      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
      // index should be truncated most aggressively
      expect(frame.index.length).toBeLessThan(2400);
      // identity and project should still have content
      expect(frame.identity.length).toBeGreaterThan(0);
      expect(frame.project.length).toBeGreaterThan(0);
    });

    it('truncates project second when index alone is under budget', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'a'.repeat(800) }, // 200 tokens
        { label: 'project', content: 'b'.repeat(2400) }, // 600 tokens (oversized)
        { label: 'index', content: 'c'.repeat(1200) }, // 300 tokens
      ];

      const frame = buildInjection(parts);

      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
      // project should be truncated
      expect(frame.project.length).toBeLessThan(2400);
      // identity should still be intact
      expect(frame.identity.length).toBe(800);
    });

    it('preserves identity last (never drops entirely)', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'very important identity info' },
        { label: 'project', content: 'x'.repeat(4000) }, // 1000 tokens (huge)
        { label: 'index', content: 'y'.repeat(4000) }, // 1000 tokens (huge)
      ];

      const frame = buildInjection(parts);

      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
      // identity should still have content
      expect(frame.identity).toContain('very');
      expect(frame.identity).toContain('important');
    });
  });

  describe('boundary cases', () => {
    it('handles exactly-at-budget input', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'a'.repeat(800) }, // 200 tokens
        { label: 'project', content: 'b'.repeat(800) }, // 200 tokens
        { label: 'index', content: 'c'.repeat(1600) }, // 400 tokens
      ];

      const frame = buildInjection(parts);

      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
      // Should keep all content since it's exactly at budget
      expect(estimateTokens(frame.identity + frame.project + frame.index)).toBeLessThanOrEqual(
        INJECTION_BUDGET_TOKENS
      );
    });

    it('handles one-over-budget input', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'a'.repeat(800) }, // 200 tokens
        { label: 'project', content: 'b'.repeat(800) }, // 200 tokens
        { label: 'index', content: 'c'.repeat(1604) }, // 401 tokens
      ];

      const frame = buildInjection(parts);

      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
    });

    it('handles all-three-empty', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: '' },
        { label: 'project', content: '' },
        { label: 'index', content: '' },
      ];

      const frame = buildInjection(parts);

      expect(frame.identity).toBe('');
      expect(frame.project).toBe('');
      expect(frame.index).toBe('');
      expect(frame.totalTokens).toBe(0);
    });

    it('handles only-identity-present', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'important user info' },
        { label: 'project', content: '' },
        { label: 'index', content: '' },
      ];

      const frame = buildInjection(parts);

      expect(frame.identity).toContain('important');
      expect(frame.project).toBe('');
      expect(frame.index).toBe('');
    });

    it('survives when three large parts all exceed budget', () => {
      // Test case from done-when 13: assert output is ≤ budget and identity survives
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'User: Alice. Preferences: dark mode. Stack: TypeScript.' },
        { label: 'project', content: 'p'.repeat(6000) }, // 1500 tokens (3x budget)
        { label: 'index', content: 'i'.repeat(6000) }, // 1500 tokens (3x budget)
      ];

      const frame = buildInjection(parts);

      // Must be under budget
      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);

      // Identity must survive (at least partial)
      expect(frame.identity.length).toBeGreaterThan(0);
      expect(frame.identity).toContain('Alice');
    });
  });

  describe('redaction: secrets are filtered from output', () => {
    it('redacts AWS keys before truncation', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'AKIAIOSFODNN7EXAMPLE' },
        { label: 'project', content: '' },
        { label: 'index', content: '' },
      ];

      const frame = buildInjection(parts);

      expect(frame.identity).toContain('[REDACTED]');
      expect(frame.identity).not.toContain('AKIA');
    });

    it('redacts GitHub tokens before truncation', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: '' },
        { label: 'project', content: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz12' },
        { label: 'index', content: '' },
      ];

      const frame = buildInjection(parts);

      expect(frame.project).toContain('[REDACTED]');
    });
  });

  describe('frame assembly', () => {
    it('returns all three parts in frame', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'identity content' },
        { label: 'project', content: 'project content' },
        { label: 'index', content: 'index content' },
      ];

      const frame = buildInjection(parts);

      expect(frame.identity).toBe('identity content');
      expect(frame.project).toBe('project content');
      expect(frame.index).toBe('index content');
    });

    it('tracks total tokens correctly', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'a'.repeat(100) }, // 25 tokens
        { label: 'project', content: 'b'.repeat(100) }, // 25 tokens
        { label: 'index', content: 'c'.repeat(100) }, // 25 tokens
      ];

      const frame = buildInjection(parts);

      const expectedTotal = 75;
      expect(frame.totalTokens).toBe(expectedTotal);
    });

    it('handles missing parts gracefully', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'content' },
        // no project
        // no index
      ];

      const frame = buildInjection(parts);

      expect(frame.identity).toBe('content');
      expect(frame.project).toBe('');
      expect(frame.index).toBe('');
    });
  });

  describe('never throws', () => {
    it('handles empty parts array', () => {
      expect(() => buildInjection([])).not.toThrow();
      const frame = buildInjection([]);
      expect(frame.totalTokens).toBe(0);
    });

    it('handles null content gracefully', () => {
      const parts: InjectionPart[] = [
        // Deliberately smuggle a null past the `content: string` type to exercise
        // the runtime fail-open guard — `unknown` avoids `any` while doing it.
        { label: 'identity', content: null as unknown as string },
      ];
      expect(() => buildInjection(parts)).not.toThrow();
    });

    it('handles very large inputs', () => {
      const parts: InjectionPart[] = [
        { label: 'identity', content: 'a'.repeat(100_000) },
        { label: 'project', content: 'b'.repeat(100_000) },
        { label: 'index', content: 'c'.repeat(100_000) },
      ];

      expect(() => buildInjection(parts)).not.toThrow();
      const frame = buildInjection(parts);
      expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
    });
  });
});
