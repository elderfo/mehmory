import type { WikiPage } from '../src/core/wiki.js';

/** In-memory input for scorer tests; page parsing is tested through openScope. */
export function page(slug: string, body: string, options: Partial<WikiPage> = {}): WikiPage {
  return {
    path: `/wiki/pages/${slug}.md`,
    slug,
    body,
    title: `${slug}.md`,
    frontmatter: {},
    decayClass: 'default',
    updatedAt: null,
    ageDays: null,
    mtimeMs: 0,
    stale: false,
    ...options,
  };
}
