import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
