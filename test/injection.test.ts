import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildInjection,
  type InjectionPart,
} from '../src/core/injection.js';
import {
  estimateTokens,
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
  it('shares one budget four ways when named, never raising the total', () => {
    // The property that replaced R10's additive slot: naming an agent buys its self a
    // place in the frame by making room, not by raising `budget_tokens`. Nominal shares
    // are identity 200 / agent 200 / project 200 / index 400 = 1000, all scaled to the
    // configured budget — so at the default 800 the scale is 0.8.
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 300) },
        { label: 'project', content: sized('b', 300) },
        { label: 'index', content: sized('c', 900) },
        { label: 'agent', content: sized('g', 300) },
      ],
      { budgetTokens: INJECTION_BUDGET_TOKENS }
    );

    expect(estimateTokens(frame.identity)).toBe(160);
    expect(estimateTokens(frame.agent ?? '')).toBe(160);
    expect(estimateTokens(frame.project)).toBe(160);
    expect(estimateTokens(frame.index)).toBe(320);
    expect(frame.totalTokens).toBe(INJECTION_BUDGET_TOKENS);
  });

  it('holds totalTokens to the budget at any budget, named or not', () => {
    // The one contract that must not bend. Degenerate budgets are already rejected at
    // the entry to `buildInjection` (`budgetTokens > 0` falls back to the default), so
    // this asserts the cap rather than re-guarding each share.
    for (const budgetTokens of [1, 2, 3, 17, 400, 800, 2000]) {
      const parts: InjectionPart[] = [
        { label: 'identity', content: sized('a', 50) },
        { label: 'project', content: sized('b', 50) },
        { label: 'index', content: sized('c', 50) },
      ];

      expect(buildInjection(parts, { budgetTokens }).totalTokens).toBeLessThanOrEqual(
        budgetTokens
      );
      expect(
        buildInjection([...parts, { label: 'agent', content: sized('g', 50) }], { budgetTokens })
          .totalTokens
      ).toBeLessThanOrEqual(budgetTokens);
    }
  });

  it('never drops identity that had content, at any budget it accepts', () => {
    // The companion to the cap above. A budget small enough that identity's share floors
    // to zero is degenerate, not a tighter budget: the boundary must refuse it, because
    // the truncation loop below has no floor of its own to fall back on.
    for (const budgetTokens of [1, 2, 3, 4, 5, 17, 400, 800, 2000]) {
      const parts: InjectionPart[] = [
        { label: 'identity', content: sized('a', 50) },
        { label: 'project', content: sized('b', 50) },
        { label: 'index', content: sized('c', 50) },
      ];

      expect(buildInjection(parts, { budgetTokens }).identity, `unnamed @ ${String(budgetTokens)}`)
        .not.toBe('');
      expect(
        buildInjection([...parts, { label: 'agent', content: sized('g', 50) }], { budgetTokens })
          .identity,
        `named @ ${String(budgetTokens)}`
      ).not.toBe('');
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
    // Absent, not empty: the field is optional so `undefined` can mean unnamed.
    expect(frame.agent).toBeUndefined();
    expect(frame.totalTokens).toBe(INJECTION_BUDGET_TOKENS);
  });

  it('narrows the other three shares when an agent joins the same budget', () => {
    // The regression this guards: leaving the 1:1:2 split computed against 800 while a
    // fourth part is also drawn would put `totalTokens` over the cap. The denominator
    // has to grow with the parts, not the budget.
    const base: InjectionPart[] = [
      { label: 'identity', content: sized('a', 300) },
      { label: 'project', content: sized('b', 300) },
      { label: 'index', content: sized('c', 900) },
    ];
    const options = { budgetTokens: INJECTION_BUDGET_TOKENS };

    const unnamed = buildInjection(base, options);
    const named = buildInjection([...base, { label: 'agent', content: sized('g', 300) }], options);

    expect(estimateTokens(named.identity)).toBeLessThan(estimateTokens(unnamed.identity));
    expect(estimateTokens(named.project)).toBeLessThan(estimateTokens(unnamed.project));
    expect(estimateTokens(named.index)).toBeLessThan(estimateTokens(unnamed.index));
    expect(named.totalTokens).toBe(unnamed.totalTokens);
  });

  it('scales every share with a raised budget when named', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 600) },
        { label: 'project', content: sized('b', 600) },
        { label: 'index', content: sized('c', 1200) },
        { label: 'agent', content: sized('g', 600) },
      ],
      { budgetTokens: 2000 }
    );

    // scale = 2000/1000 = 2, so every nominal share doubles and the index takes the rest.
    expect(estimateTokens(frame.identity)).toBe(400);
    expect(estimateTokens(frame.agent ?? '')).toBe(400);
    expect(estimateTokens(frame.project)).toBe(400);
    expect(estimateTokens(frame.index)).toBe(800);
    expect(frame.totalTokens).toBe(2000);
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

  it('leaves an unnamed agent`s split byte-identical to before agent scopes existed', () => {
    // The back-compat criterion. Passing no agent part must not perturb the allocation
    // in any way, at any budget — the nominal denominator stays 800.
    for (const budgetTokens of [400, INJECTION_BUDGET_TOKENS, 1200]) {
      const frame = buildInjection(
        [
          { label: 'identity', content: sized('a', 900) },
          { label: 'project', content: sized('b', 900) },
          { label: 'index', content: sized('c', 1800) },
        ],
        { budgetTokens }
      );

      expect(estimateTokens(frame.identity)).toBe(Math.floor(budgetTokens / 4));
      expect(estimateTokens(frame.project)).toBe(Math.floor(budgetTokens / 4));
      expect(estimateTokens(frame.index)).toBe(Math.floor(budgetTokens / 2));
      expect(frame.agent).toBeUndefined();
    }
  });

  it('lends the agent share to the other parts when the agent scope is empty', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: sized('a', 300) },
        { label: 'project', content: sized('b', 300) },
        { label: 'index', content: sized('c', 900) },
        { label: 'agent', content: '' },
      ],
      { budgetTokens: INJECTION_BUDGET_TOKENS }
    );

    // An empty agent file costs the other three nothing beyond their narrowed shares:
    // its tokens are simply available to whichever part is over. Nothing expands to
    // consume the slack — `buildInjection` only truncates — so the frame ends up under
    // the cap rather than at it.
    expect(frame.agent).toBe('');
    expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
    // Identity was never reached by the ladder: trimming index and project alone brought
    // the frame under budget, so the empty agent's share is slack identity keeps.
    expect(estimateTokens(frame.identity)).toBeGreaterThan(160);
  });
});

describe('truncation order with an agent slot', () => {
  // At the default 800 budget a named frame splits 160/160/160/320 — 640/640/640/1280
  // characters under the chars/4 heuristic.
  const named = { budgetTokens: INJECTION_BUDGET_TOKENS };

  it('truncates the index first', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(640) },
        { label: 'project', content: 'b'.repeat(640) },
        { label: 'index', content: 'c'.repeat(4000) },
        { label: 'agent', content: 'g'.repeat(640) },
      ],
      named
    );

    expect(frame.index.length).toBe(1280);
    expect(frame.identity.length).toBe(640);
    expect(frame.project.length).toBe(640);
    expect((frame.agent ?? '').length).toBe(640);
  });

  it('truncates the project next when the index is already within its share', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(640) },
        { label: 'project', content: 'b'.repeat(4000) },
        { label: 'index', content: 'c'.repeat(1280) },
        { label: 'agent', content: 'g'.repeat(640) },
      ],
      named
    );

    expect(frame.project.length).toBe(640);
    expect(frame.index.length).toBe(1280);
    expect(frame.identity.length).toBe(640);
    expect((frame.agent ?? '').length).toBe(640);
  });

  it('truncates the agent share next, and never empties it', () => {
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(640) },
        { label: 'project', content: 'b'.repeat(640) },
        { label: 'index', content: 'c'.repeat(1280) },
        { label: 'agent', content: 'agent self. '.repeat(400) },
      ],
      named
    );

    expect((frame.agent ?? '').length).toBeGreaterThan(0);
    expect(estimateTokens(frame.agent ?? '')).toBe(160);
    // Identity is untouched: the agent share yields first.
    expect(frame.identity.length).toBe(640);
  });

  it('yields the agent share before identity when both are over', () => {
    // Both parts are oversized against a budget that can still seat them, so the ladder
    // reaches the agent before identity and identity keeps its full share.
    const frame = buildInjection(
      [
        { label: 'identity', content: 'a'.repeat(4000) },
        { label: 'project', content: 'b'.repeat(640) },
        { label: 'index', content: 'c'.repeat(1280) },
        { label: 'agent', content: 'g'.repeat(4000) },
      ],
      named
    );

    expect(frame.totalTokens).toBeLessThanOrEqual(INJECTION_BUDGET_TOKENS);
    expect(frame.identity.length).toBeGreaterThan(0);
    expect((frame.agent ?? '').length).toBeGreaterThan(0);
    // Neither outranks the other once both are trimmed to their equal shares.
    expect(estimateTokens(frame.agent ?? '')).toBeLessThanOrEqual(
      estimateTokens(frame.identity)
    );
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

  it('does not grow the budget when named', () => {
    write('global/identity.md', 'a'.repeat(4000));
    write(`projects/${KEY}/project.md`, 'b'.repeat(4000));
    write(`projects/${KEY}/index.md`, 'c'.repeat(4000));
    write('agents/alpha/identity.md', 'g'.repeat(4000));

    const unnamed = buildScopeInjection(KEY).tokens;
    process.env['MEHMORY_AGENT'] = 'alpha';
    const named = buildScopeInjection(KEY).tokens;

    // `budget_tokens` is a cap for both. The named frame carries one extra section
    // header, and nothing else grows — the agent's content came out of the same 800.
    expect(named - unnamed).toBeLessThanOrEqual(10);
    expect(unnamed - named).toBeLessThanOrEqual(10);
  });
});
