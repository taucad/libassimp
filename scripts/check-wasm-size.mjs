#!/usr/bin/env node
// Size report and shape check for the three shipped binaries and their glue.

import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

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
for (const variant of ['exporter', 'importer', 'full']) {
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

  // `--strip-debug,--strip-producers` must leave no custom section behind, and
  // `-fwasm-exceptions` must leave the tag section (id 13) in place.
  if (ids.includes(0)) failures.push(`libassimp-${variant} still carries a custom section`);
  if (!ids.includes(13)) failures.push(`libassimp-${variant} has no exception tag section`);
}

if (failures.length > 0) throw new Error(failures.join('; '));
console.log('wasm section shape holds');
