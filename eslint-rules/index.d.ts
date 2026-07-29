declare const customRules: {
  rules: {
    'no-fs-imports': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => Record<string, unknown>;
    };
    'no-process-exit': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => Record<string, unknown>;
    };
    'no-exported-promise': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => Record<string, unknown>;
    };
    'no-stderr': {
      meta: { type: string; docs: unknown };
      create: (context: unknown) => Record<string, unknown>;
    };
  };
};

export default customRules;
