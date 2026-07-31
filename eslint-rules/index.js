// Custom ESLint rules for mehmory architecture decisions

import { dirname, resolve, sep } from 'node:path';

const noFsImports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid node:fs imports outside src/core/fs.ts and src/core/errors.ts (A3)',
      category: 'Possible Errors'
    }
  },
  create(context) {
    const filename = context.filename;
    // Allow fs imports in fs.ts, errors.ts, and test files
    const isAllowed =
      filename.includes('src/core/fs.ts') ||
      filename.includes('src/core/errors.ts') ||
      filename.includes('test/');

    return {
      ImportDeclaration(node) {
        if (!isAllowed && (node.source.value === 'fs' || node.source.value === 'node:fs')) {
          context.report({
            node,
            message: 'fs imports only allowed in src/core/fs.ts and src/core/errors.ts (A3)'
          });
        }
      }
    };
  }
};

const noProcessExit = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid process.exit/process.abort in src/core/ (A11)',
      category: 'Possible Errors'
    }
  },
  create(context) {
    const filename = context.filename;
    const isCore = filename.includes('src/core/');

    return {
      MemberExpression(node) {
        if (isCore && node.object.name === 'process' &&
            (node.property.name === 'exit' || node.property.name === 'abort')) {
          context.report({
            node,
            message: `process.${node.property.name} is forbidden in src/core/ (A11)`
          });
        }
      }
    };
  }
};

const noExportedPromise = {
  meta: {
    type: 'problem',
    docs: {
      description: 'No exported async functions or Promise returns in src/core/ (A9)',
      category: 'Possible Errors'
    }
  },
  create(context) {
    const filename = context.filename;
    const isCore = filename.includes('src/core/');

    const checkFunctionAsync = (decl) => {
      if (!decl) return false;
      if (decl.async === true) return true;
      // Check arrow functions: export const f = async () => {}
      if (decl.init?.async === true) return true;
      return false;
    };

    const checkReturnType = (decl) => {
      if (!decl) return false;
      // Check function/method return types
      if (decl.returnType) {
        const returnTypeText = context.sourceCode.getText(decl.returnType);
        if (returnTypeText.includes('Promise')) return true;
      }
      // Check arrow function return types: export const f = (): Promise<X> => {}
      if (decl.init?.returnType) {
        const returnTypeText = context.sourceCode.getText(decl.init.returnType);
        if (returnTypeText.includes('Promise')) return true;
      }
      return false;
    };

    return {
      ExportNamedDeclaration(node) {
        if (!isCore) return;

        const decl = node.declaration;

        if (checkFunctionAsync(decl)) {
          context.report({
            node,
            message: 'Exported async functions forbidden in src/core/ (A9 - core is synchronous)'
          });
        }

        if (checkReturnType(decl)) {
          context.report({
            node,
            message: 'Exported functions cannot return Promise in src/core/ (A9 - core is synchronous)'
          });
        }
      },
      ExportDefaultDeclaration(node) {
        if (!isCore) return;

        if (checkFunctionAsync(node.declaration)) {
          context.report({
            node,
            message: 'Exported async functions forbidden in src/core/ (A9 - core is synchronous)'
          });
        }
      }
    };
  }
};

const noStderr = {
  meta: {
    type: 'problem',
    docs: {
      description: 'No process.stderr, console.error, or console.warn in src/core/ (U2)',
      category: 'Possible Errors'
    }
  },
  create(context) {
    const filename = context.filename;
    const isCore = filename.includes('src/core/');

    return {
      CallExpression(node) {
        if (!isCore) return;

        const callee = node.callee;

        // Check console.error, console.warn
        if (callee.type === 'MemberExpression' &&
            callee.object.name === 'console' &&
            (callee.property.name === 'error' || callee.property.name === 'warn')) {
          context.report({
            node,
            message: `console.${callee.property.name} forbidden in src/core/ (U2 - silence by default)`
          });
        }

        // Check process.stderr.write
        if (callee.type === 'MemberExpression' &&
            callee.object.type === 'MemberExpression' &&
            callee.object.object.name === 'process' &&
            callee.object.property.name === 'stderr') {
          context.report({
            node,
            message: 'process.stderr forbidden in src/core/ (U2 - silence by default)'
          });
        }
      }
    };
  }
};

const noCliImports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid src/core/** and src/hooks/** from importing src/cli/** (A17)',
      category: 'Possible Errors'
    }
  },
  create(context) {
    // Scoped to exactly the two directories A17 names. Deliberately NOT reusing the
    // `filename.includes('src/core/')` shape of the older rules as a single check —
    // those claim to cover src/hooks/ and do not (see docs/WORLD_MODEL.md A12); this
    // rule names both paths explicitly so it cannot inherit that gap.
    const filename = context.filename.split(sep).join('/');
    const isGuarded =
      filename.includes('src/core/') || filename.includes('src/hooks/');

    return {
      ImportDeclaration(node) {
        if (!isGuarded) return;

        const source = node.source.value;
        if (typeof source !== 'string') return;

        // Relative specifiers are resolved against the importing file so that
        // '../cli/index.js' from src/core/ is caught, while a package literally
        // named e.g. 'oclif' is not.
        const target = source.startsWith('.')
          ? resolve(dirname(filename), source).split(sep).join('/')
          : source;

        if (target.includes('src/cli/') || target.endsWith('src/cli')) {
          context.report({
            node,
            message:
              'src/core/ and src/hooks/ must not import src/cli/ (A17 - the CLI is a consumer of the library, never the reverse)'
          });
        }
      }
    };
  }
};

export default {
  rules: {
    'no-fs-imports': noFsImports,
    'no-process-exit': noProcessExit,
    'no-exported-promise': noExportedPromise,
    'no-stderr': noStderr,
    'no-cli-imports': noCliImports
  }
};
