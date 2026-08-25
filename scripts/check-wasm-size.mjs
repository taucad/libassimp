#!/usr/bin/env node
// Byte ratchet and shape check for the shipped binary and glue.
// Ceilings only move down except in the pull request that causes growth, and
// every move records its measured origin here.

import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Origin: production emsdk 6.0.8 build at compile/link `-O3`, standalone
// `wasm-opt -O4`, mimalloc, explicit legacy EH, and glTF 1 removed (see
// CMakeLists.txt), engine c06c37a38, measured 2026-08-25 NZST on macOS arm64; 1%
// headroom. Against the 2026-08-23 pre-removal/bridge build, raw sizes fell by
// 132,548 B for the retained full-format build.
const CEILING = { raw: 11_813_270, gzip9: 3_095_278, brotli11: 2_082_890 };
// Closure keeps every glue under 39 kB; above 50 kB it silently stopped.
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
const wasm = await readFile(new URL('../dist/wasm/libassimp.wasm', import.meta.url));
const glue = await readFile(new URL('../dist/wasm/libassimp.js', import.meta.url));
const sizes = {
  raw: wasm.byteLength,
  gzip9: gzipSync(wasm, { level: 9 }).byteLength,
  brotli11: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
};
const ids = sectionIds(wasm);
console.log(JSON.stringify({ ...sizes, glue: glue.byteLength, sections: ids.length }, undefined, 0));

for (const [kind, limit] of Object.entries(CEILING)) {
  if (sizes[kind] > limit) failures.push(`libassimp ${kind} ${sizes[kind]} exceeds ${limit}`);
}
if (glue.byteLength > GLUE_CEILING)
  failures.push(`libassimp glue ${glue.byteLength} exceeds ${GLUE_CEILING}`);
// `--strip-debug,--strip-producers` must leave no custom section behind, and
// `-fwasm-exceptions` must leave the tag section (id 13) in place.
if (ids.includes(0)) failures.push('libassimp still carries a custom section');
if (!ids.includes(13)) failures.push('libassimp has no exception tag section');

if (failures.length > 0) throw new Error(failures.join('; '));
console.log('wasm byte ratchets and section shape hold');
