// The size strip quotes measured bytes, never hand-typed ones. This compresses the binary
// and built JavaScript entrypoint, then writes lib/sizes.json, which is
// checked in so drift shows up as a diff. The wasm figures cover the same bytes
// ../../scripts/check-wasm-size.mjs ratchets, so a ceiling move lands here too.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const site = new URL('../', import.meta.url);
const root = new URL('../../', import.meta.url);
const target = new URL('lib/sizes.json', site);
const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const compress = (bytes) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  raw: bytes.byteLength,
  gzip: gzipSync(bytes, { level: 9 }).byteLength,
  brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
});

const binary = new URL('src/wasm/libassimp.wasm', root);
const cached = previous.wasm;
let wasm;
if (!existsSync(binary)) {
  // A checkout without the CI-built binary keeps the committed figures, so the site still builds;
  // sizes.test.ts fails when they drift from a binary that is present.
  if (!cached?.raw) throw new Error('no size for libassimp.wasm: absent and never committed');
  console.warn('warning: src/wasm/libassimp.wasm is absent; keeping the committed figures');
  wasm = cached;
} else {
  const bytes = readFileSync(binary);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // ponytail: brotli-11 is expensive, so identical content reuses the committed figures.
  wasm = cached?.sha256 === sha256 ? cached : compress(bytes);
  console.log(`${wasm.raw} B raw, ${wasm.brotli} B brotli`);
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
