#!/usr/bin/env node
// Byte ratchet for the three shipped wasm binaries. Ceilings only move down
// except in the pull request that causes growth, and every move records its
// measured origin here.

import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const VARIANTS = ['full', 'importer', 'exporter'];

// Origin: provisional bootstrap ceilings, not measurements. The blueprint's
// only reference points are the fast-build artefacts of the reference fork
// (brotli-11: `exporter` 1,210,757, `all` 1,791,363 on 2026-08-22), which a
// production Emscripten 6 build should beat; OQ2 sets 2.6 MB brotli as the
// point at which the `full` entry stops being worth its build cost. Blueprint
// step R4 replaces every number below with the first production build's
// measurement plus about 1%, and states its origin here.
const CEILINGS = { raw: 12_000_000, gzip9: 3_400_000, brotli11: 2_600_000 };

const measure = async (variant) => {
  const wasm = await readFile(new URL(`../dist/wasm/libassimp-${variant}.wasm`, import.meta.url));
  return {
    raw: wasm.byteLength,
    gzip9: gzipSync(wasm, { level: 9 }).byteLength,
    brotli11: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  };
};

const sizes = Object.fromEntries(
  await Promise.all(VARIANTS.map(async (variant) => [variant, await measure(variant)])),
);
console.log(JSON.stringify({ sizes, ceilings: CEILINGS }, null, 2));

const failures = VARIANTS.flatMap((variant) =>
  Object.entries(CEILINGS)
    .filter(([kind, ceiling]) => sizes[variant][kind] > ceiling)
    .map(([kind, ceiling]) => `libassimp-${variant} ${kind} ${sizes[variant][kind]} exceeds ${ceiling}`),
);
if (failures.length > 0) throw new Error(failures.join('; '));
