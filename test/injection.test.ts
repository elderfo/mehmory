import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildInjection,
  type InjectionPart,
} from '../src/core/injection.js';
import {
  estimateTokens,
  INJECTION_AGENT_TOKENS,
  INJECTION_BUDGET_TOKENS,
} from '../src/core/tokens.js';
import { ROUTING_BLOCK, buildScopeInjection } from '../src/core/capture.js';
import { mehmoryHome } from '../src/core/home.js';

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

describe('sub-budget allocation (KTD6)', () => {
  it('never sums its floors past a budget too small to seat them', () => {
    // Copilot caught this: identity and the agent slot are each floored at one token so
    // neither is emptied, but two independent floors could sum to 2 against a budget of
    // 1 and break the documented `totalTokens <= budget` contract. The agent yields here
    // for the same reason it yields first in the truncation ladder.
    for (const budgetTokens of [1, 2, 3]) {
      const frame = buildInjection(
        [
          { label: 'identity', content: sized('a', 50) },
          { label: 'project', content: sized('b', 50) },
          { label: 'index', content: sized('c', 50) },
          { label: 'agent', content: sized('g', 50) },
        ],
        { budgetTokens }
      );

      expect(frame.totalTokens).toBeLessThanOrEqual(budgetTokens);
      // Identity is the one that must survive at any budget.
      expect(estimateTokens(frame.identity)).toBeGreaterThanOrEqual(1);
    }
  });

  /** Content sized to `tokens` under the chars/4 heuristic. */
  function sized(char: string, tokens: number): string {
    return char.repeat(tokens * 4);
  }

  it('splits an unnamed injection 200/200/400 at the default budget', () => {
    const frame = buildInjection([
      { label: 'identity', content: sized('a', 300) },
      { label: 'project', content: sized('b', 300) },
      { label: 'index', content: sized('c', 900) },
    ]);

    expect(estimateTokens(frame.identity)).toBe(200);
    expect(estimateTokens(frame.project)).toBe(200);
    expect(estimateTokens(frame.index)).toBe(400);
    expect(frame.agent).toBe('');
    expect(frame.totalTokens).toBe(INJECTION_BUDGET_TOKENS);
  });

  it('adds the agent slot on top without rescaling the other three', () => {
    // The regression this guards: deriving sub-budgets by scaling the 1:1:2 ratio to
    // the larger total would hand identity 250, project 250 and index 500. R10 fixes
    // all three at their current sizes and grows the total by one slot.
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 300) },
        { label: 'project', content: sized('b', 300) },
        { label: 'index', content: sized('c', 900) },
        { label: 'agent', content: sized('g', 300) },
      ],
      { budgetTokens: INJECTION_BUDGET_TOKENS + INJECTION_AGENT_TOKENS }
    );

    expect(estimateTokens(frame.identity)).toBe(200);
    expect(estimateTokens(frame.project)).toBe(200);
    expect(estimateTokens(frame.index)).toBe(400);
    expect(estimateTokens(frame.agent ?? '')).toBe(INJECTION_AGENT_TOKENS);
    expect(frame.totalTokens).toBe(INJECTION_BUDGET_TOKENS + INJECTION_AGENT_TOKENS);
  });

  it('grows a raised budget by the same fixed slot', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 400) },
        { label: 'project', content: sized('b', 400) },
        { label: 'index', content: sized('c', 1200) },
        { label: 'agent', content: sized('g', 300) },
      ],
      { budgetTokens: 1200 + INJECTION_AGENT_TOKENS }
    );

    expect(frame.totalTokens).toBe(1400);
    // The slot is the only fixed part: the other three split the configured 1200 in
    // the same 1:1:2 they always have, so a raised budget widens all of them.
    expect(estimateTokens(frame.agent ?? '')).toBe(INJECTION_AGENT_TOKENS);
    expect(estimateTokens(frame.identity)).toBe(300);
    expect(estimateTokens(frame.project)).toBe(300);
    expect(estimateTokens(frame.index)).toBe(600);
  });

  it('scales all three parts up with a raised unnamed budget', () => {
    // Regression: pinning identity and project at their constants above the nominal
    // sum truncated a raised-budget user's identity at 200 tokens where 500 fit.
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 600) },
        { label: 'project', content: sized('b', 600) },
        { label: 'index', content: sized('c', 1200) },
      ],
      { budgetTokens: 2000 }
    );

    expect(estimateTokens(frame.identity)).toBe(500);
    expect(estimateTokens(frame.project)).toBe(500);
    expect(estimateTokens(frame.index)).toBe(1000);
    expect(frame.totalTokens).toBe(2000);
  });

  it('scales all three parts down with a lowered unnamed budget', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 300) },
        { label: 'project', content: sized('b', 300) },
        { label: 'index', content: sized('c', 900) },
      ],
      { budgetTokens: 400 }
    );

    expect(estimateTokens(frame.identity)).toBe(100);
    expect(estimateTokens(frame.project)).toBe(100);
    expect(estimateTokens(frame.index)).toBe(200);
    expect(frame.totalTokens).toBe(400);
  });

  it('gives a named agent the unnamed shares at the same configured budget', () => {
    // The property R10 actually asks for: the slot is additive, it does not reshape
    // what identity, project and index would have got without it.
    const configured = 1200;
    const base: InjectionPart[] = [
      { label: 'identity', content: sized('a', 600) },
      { label: 'project', content: sized('b', 600) },
      { label: 'index', content: sized('c', 1200) },
    ];

    const unnamed = buildInjection(base, { budgetTokens: configured });
    const named = buildInjection([...base, { label: 'agent', content: sized('g', 300) }], {
      budgetTokens: configured + INJECTION_AGENT_TOKENS,
    });

    expect(estimateTokens(named.identity)).toBe(estimateTokens(unnamed.identity));
    expect(estimateTokens(named.project)).toBe(estimateTokens(unnamed.project));
    expect(estimateTokens(named.index)).toBe(estimateTokens(unnamed.index));
    expect(estimateTokens(named.agent ?? '')).toBe(INJECTION_AGENT_TOKENS);
    expect(named.totalTokens).toBe(configured + INJECTION_AGENT_TOKENS);
  });

  it('leaves the other three parts intact when the agent scope is empty', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 300) },
        { label: 'project', content: sized('b', 300) },
        { label: 'index', content: sized('c', 900) },
        { label: 'agent', content: '' },
      ],
      { budgetTokens: INJECTION_BUDGET_TOKENS + INJECTION_AGENT_TOKENS }
    );

    // An empty agent file costs the other three nothing: the slot's slack is simply
    // available to whichever part is over its share.
    expect(frame.agent).toBe('');
    expect(frame.totalTokens).toBeLessThanOrEqual(
      INJECTION_BUDGET_TOKENS + INJECTION_AGENT_TOKENS
    );
    expect(estimateTokens(frame.identity)).toBeGreaterThanOrEqual(200);
    expect(estimateTokens(frame.project)).toBeGreaterThanOrEqual(200);
    expect(estimateTokens(frame.index)).toBeGreaterThanOrEqual(400);
  });
});

describe('truncation order with an agent slot', () => {
  const named = { budgetTokens: INJECTION_BUDGET_TOKENS + INJECTION_AGENT_TOKENS };

  it('truncates the index first', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(800) },
        { label: 'project', content: 'b'.repeat(800) },
        { label: 'index', content: 'c'.repeat(4000) },
        { label: 'agent', content: 'g'.repeat(800) },
      ],
      named
    );

    expect(frame.index.length).toBe(1600);
    expect(frame.identity.length).toBe(800);
    expect(frame.project.length).toBe(800);
    expect((frame.agent ?? '').length).toBe(800);
  });

  it('truncates the project next when the index is already within its share', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(800) },
        { label: 'project', content: 'b'.repeat(4000) },
        { label: 'index', content: 'c'.repeat(1600) },
        { label: 'agent', content: 'g'.repeat(800) },
      ],
      named
    );

    expect(frame.project.length).toBe(800);
    expect(frame.index.length).toBe(1600);
    expect(frame.identity.length).toBe(800);
    expect((frame.agent ?? '').length).toBe(800);
  });

  it('truncates the agent slot next, and never empties it', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(800) },
        { label: 'project', content: 'b'.repeat(800) },
        { label: 'index', content: 'c'.repeat(1600) },
        { label: 'agent', content: 'agent self. '.repeat(400) },
      ],
      named
    );

    expect((frame.agent ?? '').length).toBeGreaterThan(0);
    expect(estimateTokens(frame.agent ?? '')).toBe(INJECTION_AGENT_TOKENS);
    // Identity is untouched: the agent slot yields first.
    expect(frame.identity.length).toBe(800);
  });

  it('yields the agent slot before identity under extreme overflow', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'identity that must survive' },
        { label: 'project', content: 'p'.repeat(4000) },
        { label: 'index', content: 'i'.repeat(4000) },
        { label: 'agent', content: 'agent self that may be cut'.repeat(200) },
      ],
      { budgetTokens: 3 }
    );

    expect(frame.totalTokens).toBeLessThanOrEqual(3);
    expect(frame.identity.length).toBeGreaterThan(0);
    expect((frame.agent ?? '').length).toBeGreaterThan(0);
    expect(estimateTokens(frame.agent ?? '')).toBeLessThanOrEqual(estimateTokens(frame.identity));
  });
});

describe('buildScopeInjection: the agent scope', () => {
  const KEY = 'github.com/acme/widgets';

  function write(relative: string, content: string): void {
    const file = join(mehmoryHome(), ...relative.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }

  function seedStore(): void {
    write('global/identity.md', 'user prefers dark mode');
    write(`projects/${KEY}/project.md`, 'widgets is a TypeScript monorepo');
    write(`projects/${KEY}/index.md`, '- [deploy](pages/deploy.md) — deploy runbook');
  }

  afterEach(() => {
    delete process.env['MEHMORY_AGENT'];
  });

  it('omits the agent section when the agent is unnamed', () => {
    seedStore();

    const { text } = buildScopeInjection(KEY);

    expect(text).toContain('# identity');
    expect(text).not.toContain('# agent');
  });

  it('injects the named agent scope and nothing from another agent', () => {
    seedStore();
    write('agents/alpha/identity.md', 'alpha writes terse commit messages');
    write('agents/beta/identity.md', 'beta writes verbose commit messages');

    process.env['MEHMORY_AGENT'] = 'alpha';
    const { text } = buildScopeInjection(KEY);

    expect(text).toContain('# agent alpha');
    expect(text).toContain('alpha writes terse');
    expect(text).not.toContain('beta');
    expect(text).not.toContain('verbose');
  });

  it('injects the same agent content for two sessions resolving one name', () => {
    seedStore();
    write('agents/alpha/identity.md', 'alpha writes terse commit messages');

    process.env['MEHMORY_AGENT'] = 'alpha';
    const first = buildScopeInjection(KEY);
    const second = buildScopeInjection(KEY);

    expect(second.text).toBe(first.text);
  });

  it('injects the other three parts when the agent has no identity.md yet', () => {
    seedStore();
    mkdirSync(join(mehmoryHome(), 'agents', 'alpha'), { recursive: true });

    process.env['MEHMORY_AGENT'] = 'alpha';
    expect(() => buildScopeInjection(KEY)).not.toThrow();
    const { text } = buildScopeInjection(KEY);

    expect(text).toContain('dark mode');
    expect(text).toContain('TypeScript monorepo');
    expect(text).toContain('deploy runbook');
    expect(text).not.toContain('# agent');
  });

  it('grows the budget by exactly one agent slot when named', () => {
    write('global/identity.md', 'a'.repeat(4000));
    write(`projects/${KEY}/project.md`, 'b'.repeat(4000));
    write(`projects/${KEY}/index.md`, 'c'.repeat(4000));
    write('agents/alpha/identity.md', 'g'.repeat(4000));

    const unnamed = buildScopeInjection(KEY).tokens;
    process.env['MEHMORY_AGENT'] = 'alpha';
    const named = buildScopeInjection(KEY).tokens;

    // One fixed slot plus the section header, and nothing else moved.
    expect(named - unnamed).toBeGreaterThanOrEqual(INJECTION_AGENT_TOKENS);
    expect(named - unnamed).toBeLessThanOrEqual(INJECTION_AGENT_TOKENS + 10);
  });
});
