#!/usr/bin/env node
// Stage the CI-built Emscripten artifacts into the published `dist/wasm/`, plus
// the CommonJS diagnostic shim that an ESM-only tsdown build cannot emit.
// Only the glue and binary ship; the emitted `.d.ts` and `.js.symbols` stay
// internal to `src/wasm/` (see scripts/package-files.mjs).

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VARIANTS = ['full', 'importer', 'exporter'];
const EXTENSIONS = ['js', 'wasm'];

const source = new URL('../src/wasm/', import.meta.url);
const destination = new URL('../dist/wasm/', import.meta.url);
const demo = new URL('../docs-site/public/demo/', import.meta.url);

const wanted = VARIANTS.flatMap((variant) =>
  EXTENSIONS.map((extension) => `libassimp-${variant}.${extension}`),
);
const missing = wanted.filter((name) => !existsSync(new URL(name, source)));
if (missing.length > 0) {
  throw new Error(
    `missing Emscripten artifacts in src/wasm/: ${missing.join(', ')}. ` +
      'Run `pnpm run build:wasm -- --all` (needs Docker), or download the CI `wasm-*` artifacts into src/wasm/.',
  );
}

mkdirSync(fileURLToPath(destination), { recursive: true });
mkdirSync(fileURLToPath(demo), { recursive: true });
for (const name of wanted) copyFileSync(new URL(name, source), new URL(name, destination));
for (const extension of EXTENSIONS) {
  copyFileSync(new URL(`libassimp-full.${extension}`, source), new URL(`libassimp-full.${extension}`, demo));
}
copyFileSync(
  new URL('../src/cjs-error.cjs', import.meta.url),
  new URL('../dist/cjs-error.cjs', import.meta.url),
);
copyFileSync(
  new URL('../src/cjs-error.d.cts', import.meta.url),
  new URL('../dist/cjs-error.d.cts', import.meta.url),
);
console.log(`copied ${wanted.length} Emscripten artifacts, the docs pair, and the CommonJS shim`);
