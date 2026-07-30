import { describe, it, expect } from 'vitest';
import customRules from '../eslint-rules/index.js';

// Test the custom ESLint rules programmatically
describe('custom ESLint rules (A3, A9, A11, U2)', () => {
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
});
