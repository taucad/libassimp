import { defineConfig } from 'vitest/config';

// The shared behaviour suites against the native addon. Unlike
// `vitest.config.ts` there is no loader alias: the built Node entry loads the
// real NAPI-RS loader and the target's addon from `dist/native`.
export default defineConfig({
  test: {
    env: { LIBASSIMP_TEST_BACKEND: 'native' },
    include: ['tests/format-matrix.test.mjs', 'tests/usd.test.mjs'],
    environment: 'node',
    reporters: ['verbose'],
    // Origin: the same bound as vitest.config.ts; native is faster per fixture.
    testTimeout: 30_000,
  },
});
