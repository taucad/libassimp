#!/usr/bin/env node
// Byte ratchet and shape check for the three shipped binaries and their glue.
// Ceilings only move down except in the pull request that causes growth, and
// every move records its measured origin here.

import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Origin: the production Emscripten 6.0.8 build of each variant with source paths
// remapped out of the binary and --converge dropped, plus about 1% headroom.
// Manifests: `src/wasm/libassimp-<variant>.manifest.json`, engine 24c936c1,
// measured 2026-08-23 on macOS arm64. Dropping --converge is what costs bytes
// (+3,190 brotli-11 on `importer`, +0.17%); the prefix maps give about 100 back.
// See CMakeLists.txt for the build time the trade bought.
const CEILINGS = {
  exporter: { raw: 7_705_011, gzip9: 1_949_578, brotli11: 1_266_377 },
  importer: { raw: 10_226_360, gzip9: 2_831_319, brotli11: 1_881_287 },
  full: { raw: 11_627_350, gzip9: 3_201_826, brotli11: 2_117_248 },
};
// Closure keeps every glue under 36 kB; above 50 kB it silently stopped.
const GLUE_CEILING = 50_000;

const decodeVaruint = (bytes, at) => {
  let value = 0;
  let shift = 0;
  let offset = at;
  for (;;) {
    const byte = bytes[offset];
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
};

/** Section ids the binary carries, in order. Custom sections have id 0. */
const sectionIds = (wasm) => {
  if (wasm.readUInt32LE(0) !== 0x6d73_6100) throw new Error('not a WebAssembly module');
  const ids = [];
  let offset = 8;
  while (offset < wasm.length) {
    const id = wasm[offset];
    const [size, next] = decodeVaruint(wasm, offset + 1);
    ids.push(id);
    offset = next + size;
  }
  return ids;
};

const failures = [];
for (const [variant, ceiling] of Object.entries(CEILINGS)) {
  const wasm = await readFile(new URL(`../dist/wasm/libassimp-${variant}.wasm`, import.meta.url));
  const glue = await readFile(new URL(`../dist/wasm/libassimp-${variant}.js`, import.meta.url));
  const sizes = {
    raw: wasm.byteLength,
    gzip9: gzipSync(wasm, { level: 9 }).byteLength,
    brotli11: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  };
  const ids = sectionIds(wasm);
  console.log(
    JSON.stringify({ variant, ...sizes, glue: glue.byteLength, sections: ids.length }, undefined, 0),
  );

  for (const [kind, limit] of Object.entries(ceiling)) {
    if (sizes[kind] > limit) failures.push(`libassimp-${variant} ${kind} ${sizes[kind]} exceeds ${limit}`);
  }
  if (glue.byteLength > GLUE_CEILING) {
    failures.push(`libassimp-${variant} glue ${glue.byteLength} exceeds ${GLUE_CEILING}`);
  }
  // `--strip-debug,--strip-producers` must leave no custom section behind, and
  // `-fwasm-exceptions` must leave the tag section (id 13) in place.
  if (ids.includes(0)) failures.push(`libassimp-${variant} still carries a custom section`);
  if (!ids.includes(13)) failures.push(`libassimp-${variant} has no exception tag section`);
}

if (failures.length > 0) throw new Error(failures.join('; '));
console.log('wasm byte ratchets and section shape hold');
