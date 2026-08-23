// The size strip quotes measured bytes, never hand-typed ones. This compresses the three binaries
// the package ships and the built JavaScript entrypoint, then writes lib/sizes.json, which is
// checked in so drift shows up as a diff. The wasm figures cover the same bytes
// ../../scripts/check-wasm-size.mjs ratchets, so a ceiling move lands here too.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const site = new URL('../', import.meta.url);
const root = new URL('../../', import.meta.url);
const target = new URL('lib/sizes.json', site);
const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const VARIANTS = ['full', 'importer', 'exporter'];

const compress = (bytes) => ({
  raw: bytes.byteLength,
  gzip: gzipSync(bytes, { level: 9 }).byteLength,
  brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
});

const wasm = {};
for (const variant of VARIANTS) {
  const binary = new URL(`src/wasm/libassimp-${variant}.wasm`, root);
  const cached = previous.wasm?.[variant];
  if (!existsSync(binary)) {
    // A checkout without the CI-built binaries keeps the committed figures, so the site still
    // builds; sizes.test.ts is what fails when they drift from binaries that are present.
    if (!cached) throw new Error(`no size for libassimp-${variant}.wasm: absent and never committed`);
    console.warn(`warning: src/wasm/libassimp-${variant}.wasm is absent; keeping the committed figures`);
    wasm[variant] = cached;
    continue;
  }
  const bytes = readFileSync(binary);
  // ponytail: brotli-11 costs about 20 s per binary, so an unchanged raw length reuses the
  // committed figures. Hash the binary here if a same-length rebuild ever ships different bytes.
  wasm[variant] = cached?.raw === bytes.byteLength ? cached : compress(bytes);
  console.log(`${variant}: ${wasm[variant].raw} B raw, ${wasm[variant].brotli} B brotli`);
}

const distribution = new URL('dist/index.mjs', root);
if (!existsSync(distribution)) {
  execFileSync('pnpm', ['--dir', '..', 'exec', 'tsdown'], { cwd: fileURLToPath(site), stdio: 'inherit' });
}
const javascript = readFileSync(distribution);
const measured = {
  version,
  wasm,
  js: { raw: javascript.byteLength, gzip: gzipSync(javascript, { level: 9 }).byteLength },
};

// Restamping on every build would churn the file in every diff, which is the opposite of what
// checking it in is for.
const { measuredAt = new Date().toISOString(), ...committed } = previous;
const unchanged = JSON.stringify(committed) === JSON.stringify(measured);
writeFileSync(
  target,
  `${JSON.stringify({ ...measured, measuredAt: unchanged ? measuredAt : new Date().toISOString() }, undefined, 2)}\n`,
);
console.log(`wrote lib/sizes.json${unchanged ? ' (unchanged)' : ''}`);
