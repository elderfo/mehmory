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

  it('keeps the capture Fixed entries wrapped in one list', () => {
    const body = readFileSync('CHANGELOG.md', 'utf8');
    const fixed = body.split('### Fixed\n\n')[1]?.split('- **Suppressed hook calls')[0] ?? '';
    expect(fixed).toContain('- **Capture retries keep their delta.**');
    expect(fixed).not.toContain('\n\n');
    expect(
      fixed
        .trim()
        .split('\n')
        .every((line) => line.length <= 100)
    ).toBe(true);
  });
});
