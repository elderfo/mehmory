// Listeners are keyed by AST node type (e.g. 'ImportDeclaration') and each
// receives the matching node; both context and node are `unknown` here because
// this file only exists to make eslint-rules/index.js (a plain, unchecked JS
// file per A3's allowlist) callable from typed code, not to model ESLint's
// full Rule.RuleContext/AST types.
type RuleListeners = Record<string, (node: unknown) => void>;

declare const customRules: {
  rules: {
    'no-fs-imports': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => RuleListeners;
    };
    'no-process-exit': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => RuleListeners;
    };
    'no-exported-promise': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => RuleListeners;
    };
    'no-stderr': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => RuleListeners;
    };
  };
};

export default customRules;
