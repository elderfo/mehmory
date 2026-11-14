import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('capture documentation', () => {
  it.each(['docs/CONFIG.md', 'docs/TROUBLESHOOTING.md', 'src/core/session-lifecycle.ts'])(
    '%s names the hashed state filename',
    (path) => {
      const body = readFileSync(path, 'utf8');
      expect(body).toContain('.state/<sha256(session-id)>.json');
      expect(body).not.toContain('.state/<session-id>.json');
    }
  );
});
