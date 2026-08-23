import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { formatSize } from './components/size-strip';
import sizes from './lib/sizes.json';

const ROOT = resolve(import.meta.dirname, '..');
const VARIANTS = ['full', 'importer', 'exporter'] as const;

/** The figures need the CI-built binaries; `pnpm run build` at the repo root stages them. */
const wasmPath = (variant: string): string => resolve(ROOT, `src/wasm/libassimp-${variant}.wasm`);
const wasmTest = VARIANTS.every((variant) => existsSync(wasmPath(variant))) ? it : it.skip;

const distribution = resolve(ROOT, 'dist/index.mjs');
const distributionTest = existsSync(distribution) ? it : it.skip;

describe('published size figures', () => {
  it('names every shipped build', () => {
    expect(Object.keys(sizes.wasm)).toEqual([...VARIANTS]);
  });

  // Raw lengths are compared rather than recompressed: brotli-11 over 29 MB of binaries costs a
  // minute, scripts/measure-sizes.mjs writes the compressed figures on every build, and
  // scripts/check-wasm-size.mjs is the gate that recompresses and ratchets them.
  wasmTest('quotes the binaries the package ships, when src/wasm holds them', () => {
    for (const variant of VARIANTS) {
      const { raw, gzip, brotli } = sizes.wasm[variant];
      expect(raw, variant).toEqual(statSync(wasmPath(variant)).size);
      expect(brotli, variant).toBeLessThan(gzip);
      expect(gzip, variant).toBeLessThan(raw);
    }
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
    for (const variant of VARIANTS) expect(html).toContain(formatSize(sizes.wasm[variant].brotli));
    expect(html).toContain(formatSize(sizes.js.gzip));
  });
});
