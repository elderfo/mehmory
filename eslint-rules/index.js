// Custom ESLint rules for mehmory architecture decisions

import { posix } from 'node:path';

function relativeFilename(context) {
  const filename = context.filename.replace(/\\/g, '/');
  const cwd = context.cwd.replace(/\\/g, '/');
  return posix.isAbsolute(filename) || /^[a-z]:\//i.test(filename)
    ? posix.relative(cwd, filename)
    : posix.normalize(filename);
}

function staticString(node) {
  if (typeof node?.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

function findVariable(context, node, name) {
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name);
    if (variable) return variable;
  }
}

function moduleSourceListeners(context, checkSource) {
  const check = (node, source) => {
    const value = staticString(source);
    if (typeof value === 'string') checkSource(node, value);
  };

  return {
    ImportDeclaration(node) { check(node, node.source); },
    ExportNamedDeclaration(node) { check(node, node.source); },
    ExportAllDeclaration(node) { check(node, node.source); },
    ImportExpression(node) { check(node, node.source); },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require' &&
          !findVariable(context, node, 'require')?.defs.length) {
        check(node, node.arguments[0]);
      }
    }
  };
}

function propertyName(node) {
  return node.computed ? staticString(node.property) : node.property.name;
}

function isProcess(node, context, aliases) {
  return node?.name === 'process' ||
    (node?.type === 'Identifier' && aliases.has(findVariable(context, node, node.name))) ||
    (node?.type === 'MemberExpression' && node.object.name === 'globalThis' &&
      propertyName(node) === 'process');
}

const noFsImports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid node:fs imports outside src/core/fs.ts and src/core/errors.ts (A3)',
      category: 'Possible Errors'
    }
  },
  create(context) {
    const filename = relativeFilename(context);
    // Test fixtures may use fs directly; production I/O goes through the two exact files.
    const isAllowed =
      /^src\/core\/(?:fs|errors)\.ts$/.test(filename) ||
      filename.startsWith('test/');

    return moduleSourceListeners(context, (node, source) => {
      if (!isAllowed && ['fs', 'fs/promises', 'node:fs', 'node:fs/promises'].includes(source)) {
        context.report({
          node,
          message: 'fs imports only allowed in src/core/fs.ts and src/core/errors.ts (A3)'
        });
      }
    });
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
    const isCore = relativeFilename(context).startsWith('src/core/');
    const aliases = new Set();
    const isProcessObject = (node) => isProcess(node, context, aliases);

    const checkProperty = (node, name) => {
      if (name === 'exit' || name === 'abort') {
        context.report({
          node,
          message: `process.${name} is forbidden in src/core/ (A11)`
        });
      }
    };

    const checkPattern = (pattern, object) => {
      if (pattern.type !== 'ObjectPattern' || !isProcessObject(object)) return;
      for (const property of pattern.properties) {
        if (property.type === 'Property') {
          checkProperty(property, property.computed ? staticString(property.key) : property.key.name ?? property.key.value);
        }
      }
    };

    return {
      MemberExpression(node) {
        if (isCore && isProcessObject(node.object)) checkProperty(node, propertyName(node));
      },
      VariableDeclarator(node) {
        if (!isCore) return;
        if (node.id.type === 'Identifier' && isProcessObject(node.init)) {
          aliases.add(findVariable(context, node, node.id.name));
        }
        checkPattern(node.id, node.init);
      },
      AssignmentExpression(node) {
        if (isCore) checkPattern(node.left, node.right);
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
    const isCore = relativeFilename(context).startsWith('src/core/');

    const checkFunction = (node, decl) => {
      if (decl?.async === true) {
        context.report({
          node,
          message: 'Exported async functions forbidden in src/core/ (A9 - core is synchronous)'
        });
      }
      if (decl?.returnType && context.sourceCode.getText(decl.returnType).includes('Promise')) {
        context.report({
          node,
          message: 'Exported functions cannot return Promise in src/core/ (A9 - core is synchronous)'
        });
      }
    };

    const checkDeclaration = (node, decl) => {
      if (decl?.type === 'VariableDeclaration') {
        for (const declarator of decl.declarations) checkFunction(node, declarator.init);
      } else if (decl?.type === 'Identifier') {
        // Scope definitions include declarations after the export and preserve local aliases.
        const variable = findVariable(context, node, decl.name);
        for (const definition of variable?.defs ?? []) {
          const declaration = definition.node;
          checkFunction(node, declaration.type === 'VariableDeclarator' ? declaration.init : declaration);
        }
      } else {
        checkFunction(node, decl);
      }
    };

    return {
      ExportNamedDeclaration(node) {
        if (!isCore) return;

        if (node.declaration) {
          checkDeclaration(node, node.declaration);
        } else if (!node.source) {
          for (const specifier of node.specifiers) checkDeclaration(specifier, specifier.local);
        }
      },
      ExportDefaultDeclaration(node) {
        if (isCore) checkDeclaration(node, node.declaration);
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
    const isCore = relativeFilename(context).startsWith('src/core/');

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
    const filename = relativeFilename(context);
    const isGuarded =
      filename.startsWith('src/core/') || filename.startsWith('src/hooks/');

    return moduleSourceListeners(context, (node, source) => {
      if (!isGuarded) return;

      // Resolve relative specifiers against the importer, not against the lint cwd.
      const target = source.startsWith('.')
        ? posix.resolve(posix.dirname(filename), source)
        : source;

      if (target.includes('src/cli/') || target.endsWith('src/cli')) {
        context.report({
          node,
          message:
            'src/core/ and src/hooks/ must not import src/cli/ (A17 - the CLI is a consumer of the library, never the reverse)'
        });
      }
    });
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
