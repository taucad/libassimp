import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const providers = {
  chromium: { browser: 'chromium', headless: true, provider: playwright() },
  firefox: { browser: 'firefox', headless: true, provider: playwright() },
  webkit: { browser: 'webkit', headless: true },
} as const;

const requestedBrowser = process.env['BROWSER'];
if (requestedBrowser && !(requestedBrowser in providers)) {
  throw new Error(`unsupported BROWSER: ${requestedBrowser}`);
}
const instances = requestedBrowser
  ? [providers[requestedBrowser as keyof typeof providers]]
  : [providers.chromium, providers.firefox, providers.webkit];

export default defineConfig({
  resolve: {
    alias: {
      // The exporter glue of the exact candidate under test; CI points this at
      // the extracted tarball, a local run at the working `src/wasm/` build.
      'libassimp-candidate': resolve(
        process.env['LIBASSIMP_WASM_MODULE'] ?? 'src/wasm/libassimp-exporter.js',
      ),
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
