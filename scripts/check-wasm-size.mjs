#!/usr/bin/env node
// Byte ratchet and shape check for the three shipped binaries and their glue.
// Ceilings only move down except in the pull request that causes growth, and
// every move records its measured origin here.

import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Origin: production emsdk 6.0.8 build at compile `-O3` / link `-O2` (see
// CMakeLists.txt), engine 24c936c1, measured 2026-08-23 on macOS arm64; 1%
// headroom. Raw is +6% because `-O2` omits `code-folding` and `wasm-metadce`;
// brotli is -2.6%; link is 214x faster.
const CEILINGS = {
  exporter: { raw: 7_738_049, gzip9: 1_859_084, brotli11: 1_258_009 },
  importer: { raw: 10_901_302, gzip9: 2_710_971, brotli11: 1_834_748 },
  full: { raw: 12_324_380, gzip9: 3_054_180, brotli11: 2_060_636 },
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
