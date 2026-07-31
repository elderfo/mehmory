import { describe, it, expect } from 'vitest';
import customRules from '../eslint-rules/index.js';

// Test the custom ESLint rules programmatically
describe('custom ESLint rules (A3, A9, A11, U2, A17)', () => {
  describe('A3: no-fs-imports', () => {
    const rule = customRules.rules['no-fs-imports'];

    it('allows fs imports in src/core/fs.ts', () => {
      const context = {
        filename: '/project/src/core/fs.ts',
        report: function() {
          throw new Error('Should not report');
        },
      };

      const listeners = rule.create(context);
      listeners.ImportDeclaration?.({
        source: { value: 'node:fs' },
      });
      // No error thrown = pass
    });

    it('allows fs imports in src/core/errors.ts', () => {
      const context = {
        filename: '/project/src/core/errors.ts',
        report: function() {
          throw new Error('Should not report');
        },
      };

      const listeners = rule.create(context);
      listeners.ImportDeclaration?.({
        source: { value: 'node:fs' },
      });
    });

    it('allows fs imports in test/ files', () => {
      const context = {
        filename: '/project/test/errors.test.ts',
        report: function() {
          throw new Error('Should not report');
        },
      };

      const listeners = rule.create(context);
      listeners.ImportDeclaration?.({
        source: { value: 'node:fs' },
      });
    });

    it('forbids fs imports in other modules', () => {
      let reported = false;
      const context = {
        filename: '/project/src/redact.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.ImportDeclaration?.({
        source: { value: 'node:fs' },
      });
      expect(reported).toBe(true);
    });

    it('forbids fs shorthand imports outside allowlist', () => {
      let reported = false;
      const context = {
        filename: '/project/src/tokens.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.ImportDeclaration?.({
        source: { value: 'fs' },
      });
      expect(reported).toBe(true);
    });
  });

  describe('A11: no-process-exit', () => {
    const rule = customRules.rules['no-process-exit'];

    it('allows process.exit in non-core modules', () => {
      let reported = false;
      const context = {
        filename: '/project/src/redact.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.MemberExpression?.({
        object: { name: 'process' },
        property: { name: 'exit' },
      });
      expect(reported).toBe(false);
    });

    it('forbids process.exit in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/store.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.MemberExpression?.({
        object: { name: 'process' },
        property: { name: 'exit' },
      });
      expect(reported).toBe(true);
    });

    it('forbids process.abort in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/home.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.MemberExpression?.({
        object: { name: 'process' },
        property: { name: 'abort' },
      });
      expect(reported).toBe(true);
    });
  });

  describe('A9: no-exported-promise', () => {
    const rule = customRules.rules['no-exported-promise'];

    it('forbids exported async functions in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/store.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.ExportNamedDeclaration?.({
        declaration: { async: true },
      });
      expect(reported).toBe(true);
    });

    it('allows exported async functions outside src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/redact.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.ExportNamedDeclaration?.({
        declaration: { async: true },
      });
      expect(reported).toBe(false);
    });

    it('forbids Promise return types in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/home.ts',
        sourceCode: {
          getText: () => 'Promise<string>',
        },
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.ExportNamedDeclaration?.({
        declaration: {
          returnType: {},
        },
      });
      expect(reported).toBe(true);
    });
  });

  describe('U2: no-stderr', () => {
    const rule = customRules.rules['no-stderr'];

    it('forbids console.error in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/errors.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.CallExpression?.({
        callee: {
          type: 'MemberExpression',
          object: { name: 'console' },
          property: { name: 'error' },
        },
      });
      expect(reported).toBe(true);
    });

    it('forbids console.warn in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/home.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.CallExpression?.({
        callee: {
          type: 'MemberExpression',
          object: { name: 'console' },
          property: { name: 'warn' },
        },
      });
      expect(reported).toBe(true);
    });

    it('forbids process.stderr.write in src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/core/store.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.CallExpression?.({
        callee: {
          type: 'MemberExpression',
          object: {
            type: 'MemberExpression',
            object: { name: 'process' },
            property: { name: 'stderr' },
          },
          property: { name: 'write' },
        },
      });
      expect(reported).toBe(true);
    });

    it('allows console.error outside src/core/', () => {
      let reported = false;
      const context = {
        filename: '/project/src/redact.ts',
        report: function() {
          reported = true;
        },
      };

      const listeners = rule.create(context);
      listeners.CallExpression?.({
        callee: {
          type: 'MemberExpression',
          object: { name: 'console' },
          property: { name: 'error' },
        },
      });
      expect(reported).toBe(false);
    });
  });

  describe('A17: no-cli-imports', () => {
    const rule = customRules.rules['no-cli-imports'];

    /** Run the rule over one (filename, import source) pair; true when it reported. */
    function reportsOn(filename: string, source: string): boolean {
      let reported = false;
      const listeners = rule.create({
        filename,
        report: function () {
          reported = true;
        },
      });
      listeners.ImportDeclaration?.({ source: { value: source } });
      return reported;
    }

    it('forbids src/core/ importing src/cli/', () => {
      expect(reportsOn('/project/src/core/store.ts', '../cli/index.js')).toBe(true);
      expect(reportsOn('/project/src/core/store.ts', '../cli/commands/search.js')).toBe(true);
    });

    it('forbids src/hooks/ importing src/cli/ — not only src/core/', () => {
      expect(reportsOn('/project/src/hooks/stop.ts', '../cli/index.js')).toBe(true);
    });

    it('allows src/cli/ importing itself and the library', () => {
      expect(reportsOn('/project/src/cli/index.ts', './commands/search.js')).toBe(false);
      expect(reportsOn('/project/src/core/store.ts', './config.js')).toBe(false);
      expect(reportsOn('/project/src/core/store.ts', 'node:path')).toBe(false);
    });

    it('does not fire on a package whose name merely contains "cli"', () => {
      expect(reportsOn('/project/src/core/store.ts', 'cli-truncate')).toBe(false);
    });
  });
});
