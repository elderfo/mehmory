import { describe, expect, it } from 'vitest';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import customRules from '../eslint-rules/index.js';

type RuleName = keyof typeof customRules.rules;

function lint(rule: RuleName, code: string, filename = 'src/core/example.ts', cwd = process.cwd()) {
  return new Linter({ cwd }).verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { custom: customRules as unknown as ESLint.Plugin },
      rules: { [`custom/${rule}`]: 'error' },
    },
    { filename }
  );
}

function expectViolation(rule: RuleName, code: string, filename?: string, cwd?: string) {
  expect(
    lint(rule, code, filename, cwd).map(({ ruleId, severity }) => ({ ruleId, severity }))
  ).toEqual([{ ruleId: `custom/${rule}`, severity: 2 }]);
}

const moduleForms = [
  (source: string) => `import * as value from '${source}';`,
  (source: string) => `export { value } from '${source}';`,
  (source: string) => `export * from '${source}';`,
  (source: string) => `export * as value from '${source}';`,
  (source: string) => `const value = require('${source}');`,
  (source: string) => `const value = import('${source}');`,
  (source: string) => `const value = require(\`${source}\`);`,
  (source: string) => `const value = import(\`${source}\`);`,
];

describe('A9: no-exported-promise through ESLint', () => {
  it.each([
    'export async function f() {}',
    'export const f = async () => 1;',
    'export const f = async function () {};',
    'export const value = 1, f = async () => 1;',
    'async function g() {} export { g };',
    'async function g() {} export { g as f };',
    'export { g }; async function g() {}',
    'const g = async () => 1; export { g };',
    'const g = async function () {}; export { g };',
    'export default async function () {}',
    'export default async () => 1;',
    'async function g() {} export default g;',
    'const g = async () => 1; export default g;',
    'export function f(): Promise<number> { return Promise.resolve(1); }',
    'export const f = (): Promise<number> => Promise.resolve(1);',
    'export const f = function (): Promise<number> { return Promise.resolve(1); };',
    'function g(): Promise<number> { return Promise.resolve(1); } export { g };',
    'export default function (): Promise<number> { return Promise.resolve(1); }',
  ])('rejects %s', (code) => {
    expectViolation('no-exported-promise', code);
  });

  it.each([
    'export function f() { return 1; }',
    'export const f = () => 1;',
    'export const f = function () { return 1; };',
    'function g() { return 1; } export { g as f };',
    'export { g }; const g = () => 1;',
    'const g = () => 1; export default g;',
    'export default function () { return 1; }',
    'async function internal() {} export const value = 1;',
    'function g(): number { return 1; } export { g };',
    "export { g } from './sync.js';",
    'export const object = { async internal() {} };',
  ])('allows %s', (code) => {
    expect(lint('no-exported-promise', code)).toEqual([]);
  });

  it('allows async exports outside core', () => {
    expect(
      lint('no-exported-promise', 'export const f = async () => 1;', 'src/cli/example.ts')
    ).toEqual([]);
  });
});

describe('A3: no-fs-imports through ESLint', () => {
  const forbidden = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].flatMap((source) =>
    moduleForms.map((form) => form(source))
  );

  it.each(forbidden)('rejects %s outside the filesystem boundary', (code) => {
    expectViolation('no-fs-imports', code);
  });

  it.each(['src/core/fs.ts', 'src/core/errors.ts', 'test/example.test.ts'])(
    'allows fs in %s',
    (filename) => {
      for (const code of forbidden) {
        expect(lint('no-fs-imports', code, filename)).toEqual([]);
      }
    }
  );

  it.each([
    'src/core/fs.ts.extra.ts',
    'src/core/errors.ts.extra.ts',
    'src/hooks/example.ts',
    'src/cli/example.ts',
  ])('rejects fs in %s', (filename) => {
    expectViolation('no-fs-imports', "import fs from 'node:fs';", filename);
  });

  it.each(moduleForms.map((form) => form('node:path')))('allows %s', (code) => {
    expect(lint('no-fs-imports', code)).toEqual([]);
  });

  it('does not treat a local require function as a module load', () => {
    expect(
      lint('no-fs-imports', "function require(name: string) { return name; } require('fs');")
    ).toEqual([]);
  });
});

describe('A11: no-process-exit through ESLint', () => {
  it.each([
    'process.exit(1);',
    'process.abort();',
    "process['exit'](1);",
    "process['abort']();",
    'globalThis.process.exit(1);',
    "globalThis['process']['exit'](1);",
    'globalThis.process.abort();',
    'const { exit } = process; exit(1);',
    'const { abort } = process; abort();',
    'const { exit: quit } = process; quit(1);',
    "const { ['exit']: quit } = process; quit(1);",
    'const { exit } = globalThis.process; exit(1);',
    'const p = process; p.exit(1);',
    'const p = globalThis.process; p.abort();',
    'const p = process; const q = p; q.exit(1);',
    'const p = process; const { exit } = p; exit(1);',
    'let exit; ({ exit } = process); exit(1);',
    'let quit; ({ exit: quit } = globalThis.process); quit(1);',
    'process[`exit`](1);',
    'process[`abort`]();',
    'globalThis[`process`][`exit`](1);',
    'const { [`exit`]: quit } = process; quit(1);',
    'let quit; ({ [`exit`]: quit } = process); quit(1);',
  ])('rejects %s', (code) => {
    expectViolation('no-process-exit', code);
  });

  it.each([
    'process.cwd();',
    'globalThis.process.cwd();',
    'const { cwd } = process; cwd();',
    'const object = { exit() {} }; object.exit();',
    "const exit = 'cwd'; process[exit]();",
    'const p = process; p.cwd();',
    'const p = process; function f(p: { exit(): void }) { p.exit(); }',
    'let exit; ({ exit } = { exit() {} }); exit();',
    'const method = "cwd"; process[`${method}`]();',
  ])('allows %s', (code) => {
    expect(lint('no-process-exit', code)).toEqual([]);
  });

  it('allows exits in CLI code', () => {
    expect(lint('no-process-exit', 'process.exit(1);', 'src/cli/example.ts')).toEqual([]);
  });
});

describe('A17: no-cli-imports through ESLint', () => {
  it.each(moduleForms.map((form) => form('../cli/index.js')))(
    'rejects %s in core and hooks',
    (code) => {
      expectViolation('no-cli-imports', code);
      expectViolation('no-cli-imports', code, 'src/hooks/example.ts');
    }
  );

  it.each(['../../cli/commands/search.js', '/project/src/cli/index.js', 'src/cli/index.js'])(
    'rejects %s',
    (source) => {
      expectViolation('no-cli-imports', `export * from '${source}';`, 'src/core/nested/example.ts');
    }
  );

  it.each([
    './config.js',
    '../core/config.js',
    'node:path',
    'cli-truncate',
    '../cli-tools/index.js',
  ])('allows %s', (source) => {
    for (const form of moduleForms) {
      expect(lint('no-cli-imports', form(source))).toEqual([]);
    }
  });

  it('allows CLI consumers to load CLI modules', () => {
    for (const form of moduleForms) {
      expect(lint('no-cli-imports', form('./commands/search.js'), 'src/cli/index.ts')).toEqual([]);
    }
  });
});

describe('U2: no-stderr through ESLint', () => {
  it.each([
    'console.error("failed");',
    'console.warn("failed");',
    'process.stderr.write("failed");',
  ])('rejects %s in core', (code) => {
    expectViolation('no-stderr', code);
    expect(lint('no-stderr', code, 'src/cli/example.ts')).toEqual([]);
  });

  it('allows stdout in core', () => {
    expect(lint('no-stderr', 'process.stdout.write("ok");')).toEqual([]);
  });
});

describe('architecture rule paths through ESLint', () => {
  const violations: [RuleName, string][] = [
    ['no-fs-imports', "import fs from 'node:fs';"],
    ['no-process-exit', 'process.exit(1);'],
    ['no-exported-promise', 'export async function f() {}'],
    ['no-stderr', 'console.error("failed");'],
    ['no-cli-imports', "import '../cli/index.js';"],
  ];

  it.each(violations)('enforces %s with backslash core paths', (rule, code) => {
    expectViolation(rule, code, 'src\\core\\x.ts');
    expectViolation(rule, code, 'C:\\p\\src\\core\\x.ts', 'C:\\p');
  });

  it.each(violations)('enforces %s under a checkout named test', (rule, code) => {
    expectViolation(rule, code, '/project/test/src/core/x.ts', '/project/test');
  });

  it.each(['src\\core\\fs.ts', 'src\\core\\errors.ts', 'test\\example.test.ts'])(
    'allows fs in backslash boundary path %s',
    (filename) => {
      expect(lint('no-fs-imports', "import fs from 'node:fs';", filename)).toEqual([]);
      expect(
        lint('no-fs-imports', "import fs from 'node:fs';", `C:\\p\\${filename}`, 'C:\\p')
      ).toEqual([]);
    }
  );

  it('enforces the CLI boundary in backslash hook paths', () => {
    expectViolation('no-cli-imports', "import '../cli/index.js';", 'src\\hooks\\x.ts');
  });
});

describe('repository ESLint configuration', () => {
  it('enables the architecture rules for source files', async () => {
    const results = await new ESLint().lintText(
      "import fs from 'node:fs/promises'; export const f = async () => 1; process['exit'](1); export * from '../cli/index.js';",
      { filePath: 'src/core/home.ts' }
    );
    expect(
      results
        .flatMap((result) => result.messages)
        .filter(({ ruleId }) => ruleId?.startsWith('custom/'))
        .map(({ ruleId }) => ruleId)
        .sort()
    ).toEqual([
      'custom/no-cli-imports',
      'custom/no-exported-promise',
      'custom/no-fs-imports',
      'custom/no-process-exit',
    ]);
  });
});
