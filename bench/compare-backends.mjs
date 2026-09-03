import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fnv64 } from '../tests/fnv64.mjs';

const script = fileURLToPath(import.meta.url);
const entryPath = process.env['LIBASSIMP_BENCH_ENTRY'];
assert(entryPath, 'LIBASSIMP_BENCH_ENTRY must name the packed Node entry');

const round = (value) => Math.round(value * 1_000) / 1_000;
const median = (values) => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];

if (process.argv[2] === '--sample') {
  const backend = process.argv[3];
  assert(backend === 'native' || backend === 'wasm');
  const bytes = new Uint8Array(readFileSync(new URL('../tests/fixtures/cube.obj', import.meta.url)));
  const entry = await import(pathToFileURL(resolve(entryPath)).href);
  const started = performance.now();
  const assimp = await entry.createAssimp({ backend });
  const readyMs = performance.now() - started;
  let result = await assimp.convert({ name: 'cube.obj', bytes }, { to: 'glb' });
  const firstConversionMs = performance.now() - started;
  const output = { bytes: result.files[0].bytes.length, fnv: fnv64(result.files[0].bytes) };
  result = undefined;
  // Establish the allocator and thread-pool high-water marks before checking steady-state growth.
  for (let index = 0; index < 10; index += 1) {
    await assimp.convert({ name: 'cube.obj', bytes }, { to: 'glb' });
  }
  globalThis.gc?.();
  const retainedRss = [process.memoryUsage().rss];
  for (let index = 0; index < 30; index += 1) {
    await assimp.convert({ name: 'cube.obj', bytes }, { to: 'glb' });
    if ((index + 1) % 5 === 0) {
      globalThis.gc?.();
      retainedRss.push(process.memoryUsage().rss);
    }
  }
  assimp.dispose();
  process.stdout.write(
    `${JSON.stringify({
      backend,
      firstConversionMs: round(firstConversionMs),
      maxRssKiB: process.resourceUsage().maxRSS,
      output,
      readyMs: round(readyMs),
      retainedRssGrowthBytes: Math.max(0, retainedRss.at(-1) - retainedRss[0]),
      retainedRssSamples: retainedRss,
    })}\n`,
  );
  process.exit(0);
}

const sample = (backend) => {
  const result = spawnSync(process.execPath, ['--expose-gc', script, '--sample', backend], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const warm = (backend) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./gated.mjs', import.meta.url))], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LIBASSIMP_BENCH_BACKEND: backend,
      // Origin: the existing shared-runner gate allows roughly 10x headroom over
      // 44.836-50.650 ms conversions and up to 68.856 ms initialization.
      MAX_INIT_MS: process.env['MAX_INIT_MS'] ?? '100',
      MAX_MEDIAN_MS: process.env['MAX_MEDIAN_MS'] ?? '500',
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const count = Number(process.env['LIBASSIMP_BENCH_SAMPLES'] ?? 7);
assert(
  Number.isSafeInteger(count) && count >= 3 && count % 2 === 1,
  'sample count must be odd and at least 3',
);
const samples = { native: [], wasm: [] };
for (let index = 0; index < count; index += 1) {
  const order = index % 2 === 0 ? ['native', 'wasm'] : ['wasm', 'native'];
  for (const backend of order) samples[backend].push(sample(backend));
}

for (const index of samples.native.keys()) {
  assert.deepEqual(samples.native[index].output, samples.wasm[index].output, 'cold output differs');
}
const summarize = (backend) => ({
  firstConversionMs: round(median(samples[backend].map((value) => value.firstConversionMs))),
  maxRssKiB: median(samples[backend].map((value) => value.maxRssKiB)),
  readyMs: round(median(samples[backend].map((value) => value.readyMs))),
  retainedRssGrowthBytes: median(samples[backend].map((value) => value.retainedRssGrowthBytes)),
});
const native = summarize('native');
const wasm = summarize('wasm');
const ratio = (slower, faster) => round(slower / faster);
const nativeWarm = warm('native');
const wasmWarm = warm('wasm');
assert.equal(nativeWarm.outputBytes, wasmWarm.outputBytes, 'warm output size differs');
assert.equal(nativeWarm.outputFnv, wasmWarm.outputFnv, 'warm output bytes differ');
const report = {
  cold: {
    firstConversionSpeedup: ratio(wasm.firstConversionMs, native.firstConversionMs),
    native,
    readySpeedup: ratio(wasm.readyMs, native.readyMs),
    samples,
    wasm,
  },
  name: 'native-wasm-node-api-v1',
  warm: { native: nativeWarm, wasm: wasmWarm },
};

const failures = [
  report.cold.readySpeedup < 5 && `ready speedup ${report.cold.readySpeedup}x is below 5x`,
  report.cold.firstConversionSpeedup < 3 &&
    `first-conversion speedup ${report.cold.firstConversionSpeedup}x is below 3x`,
  native.retainedRssGrowthBytes > 64 * 1024 * 1024 &&
    `native steady-state RSS grew ${native.retainedRssGrowthBytes} bytes across 30 conversions`,
].filter(Boolean);

const markdown = `<!-- libassimp-benchmark -->
### Native/Wasm benchmark

| Metric (p50) | Native | Wasm | Native advantage |
| --- | ---: | ---: | ---: |
| Ready to convert | ${native.readyMs} ms | ${wasm.readyMs} ms | ${report.cold.readySpeedup}× |
| Process-cold first conversion | ${native.firstConversionMs} ms | ${wasm.firstConversionMs} ms | ${report.cold.firstConversionSpeedup}× |
| Warm helical-gear conversion | ${report.warm.native.medianMs} ms | ${report.warm.wasm.medianMs} ms | ${ratio(report.warm.wasm.medianMs, report.warm.native.medianMs)}× |
| Maximum RSS | ${native.maxRssKiB} KiB | ${wasm.maxRssKiB} KiB | reported, not gated |
| Steady-state RSS growth, 30 conversions | ${native.retainedRssGrowthBytes} B | ${wasm.retainedRssGrowthBytes} B | bounded at 64 MiB native |
`;
const markdownPath = process.env['LIBASSIMP_BENCH_MARKDOWN'];
if (markdownPath) writeFileSync(markdownPath, markdown);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) throw new Error(failures.join('; '));
