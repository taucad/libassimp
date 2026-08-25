import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { formatSize } from './components/size-strip';
import sizes from './lib/sizes.json';

const ROOT = resolve(import.meta.dirname, '..');
/** The figures need the CI-built binaries; `pnpm run build` at the repo root stages them. */
const wasmPath = resolve(ROOT, 'src/wasm/libassimp.wasm');
const wasmTest = existsSync(wasmPath) ? it : it.skip;

const distribution = resolve(ROOT, 'dist/index.mjs');
const distributionTest = existsSync(distribution) ? it : it.skip;
const demoWasm = resolve(import.meta.dirname, 'public/demo/libassimp.wasm');

describe('published size figures', () => {
  it('self-hosts the measured binary used by every live demo', () => {
    expect(statSync(demoWasm).size).toBe(sizes.wasm.raw);
  });

  // Raw length is compared rather than recompressed: scripts/measure-sizes.mjs writes the
  // compressed figures on every build, and
  // scripts/check-wasm-size.mjs is the gate that recompresses and ratchets them.
  wasmTest('quotes the binary the package ships, when src/wasm holds it', () => {
    const { raw, gzip, brotli } = sizes.wasm;
    expect(raw).toEqual(statSync(wasmPath).size);
    expect(brotli).toBeLessThan(gzip);
    expect(gzip).toBeLessThan(raw);
  });

  distributionTest('quotes the built JavaScript entrypoint, when dist/index.mjs exists', () => {
    const javascript = readFileSync(distribution);
    expect(sizes.js).toEqual({
      raw: javascript.byteLength,
      gzip: gzipSync(javascript, { level: 9 }).byteLength,
    });
  });

  it('formats bytes as the strip prints them', () => {
    expect([252_013, 7_020_882, 325].map(formatSize)).toEqual(['252 KB', '7.0 MB', '0.3 KB']);
  });
});

const staticOutputTest = process.env['VERIFY_STATIC_OUTPUT'] === 'true' ? it : it.skip;

describe('static home page', () => {
  staticOutputTest('prints the measured sizes', () => {
    const html = readFileSync(resolve(import.meta.dirname, 'out/index.html'), 'utf8');
    expect(html).toContain(formatSize(sizes.wasm.brotli));
    expect(html).toContain(formatSize(sizes.js.gzip));
  });
});
