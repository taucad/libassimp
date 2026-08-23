import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tests/ci/**` is deliberately absent: those run under `node --test`.
    include: ['src/**/*.test.ts', 'tests/*.test.mjs', '*.test.ts'],
    coverage: {
      exclude: ['src/**/*.{test,spec}.ts', 'src/wasm/**', '**/*.test-d.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    environment: 'node',
    reporters: ['verbose'],
    // Origin: MDL3/MDL5's 2.85 MB fixtures took 6.0–6.3 s on the 4-vCPU
    // quality runner under parallel Nx tasks, versus 1.0–1.4 s locally.
    testTimeout: 30_000,
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
    },
  },
});
