import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'api-coverage.test.ts',
      'demo-projection.test.ts',
      'format-matrix.test.ts',
      'sizes.test.ts',
      'word-budget.test.ts',
    ],
  },
});
