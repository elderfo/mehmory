import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import customRules from './eslint-rules/index.js';

export default [
  {
    ignores: ['dist', 'node_modules', '.deliver', '**/*.js']
  },
  js.configs.recommended,
  eslintConfigPrettier,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parser: tseslint.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: process.cwd()
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      custom: customRules
    },
    rules: {
      ...tseslint.configs.strictTypeChecked[0].rules,
      // Base rule is superseded by the TS-aware one below; leaving it on double-reports
      // and cannot see parameters inside function *type* annotations.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' }
      ],
      'custom/no-fs-imports': 'error',
      'custom/no-process-exit': 'error',
      'custom/no-exported-promise': 'error',
      'custom/no-stderr': 'error'
    }
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    }
  }
];
