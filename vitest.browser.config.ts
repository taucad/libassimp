import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const providers = {
  chromium: { browser: 'chromium', headless: true },
  firefox: { browser: 'firefox', headless: true },
  webkit: { browser: 'webkit', headless: true },
} as const;

const requestedBrowser = process.env['BROWSER'];
if (requestedBrowser && !(requestedBrowser in providers)) {
  throw new Error(`unsupported BROWSER: ${requestedBrowser}`);
}
const instances = requestedBrowser
  ? [providers[requestedBrowser as keyof typeof providers]]
  : [providers.chromium, providers.firefox, providers.webkit];

// The entries of the exact candidate under test: CI points this at the
// extracted tarball's `dist`, a local run at the TypeScript sources over the
// working `src/wasm/` build.
const distribution = process.env['LIBASSIMP_DIST_DIR'];
const entry = (name: string): string =>
  resolve(distribution ? `${distribution}/${name}.mjs` : `src/${name}.ts`);

export default defineConfig({
  resolve: {
    alias: {
      'libassimp-candidate/importer': entry('importer'),
      'libassimp-candidate/exporter': entry('exporter'),
    },
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances,
    },
    hookTimeout: 120_000,
    include: ['tests/browser/**/*.browser.test.mjs'],
    reporters: ['verbose'],
    testTimeout: 120_000,
  },
});
