import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fnv64 } from '../tests/fnv64.mjs';

// Self-referencing import: the package's own `exports` map resolves this to
// `dist/index.mjs`, so the benchmark measures exactly what ships.
import { convert, createAssimp } from 'libassimp';

const bytes = new Uint8Array(readFileSync(new URL('../tests/fixtures/cube.obj', import.meta.url)));
const materialCube = new Uint8Array(
  readFileSync(new URL('../tests/fixtures/cube-material.obj', import.meta.url)),
);
const material = new Uint8Array(
  readFileSync(new URL('../tests/fixtures/cube-material.mtl', import.meta.url)),
);
const iterations = 15;

const median = (durations) => {
  const sorted = [...durations].sort((left, right) => left - right);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 1_000) / 1_000;
};

const time = async (job) => {
  const started = performance.now();
  const value = await job();
  return [performance.now() - started, value];
};

// Warm-up: the first call pays for loading and compiling the module.
await convert({ name: 'cube.obj', bytes }, { to: 'glb' });

const conversions = [];
let output;
for (let index = 0; index < iterations; index += 1) {
  const [duration, { files }] = await time(() => convert({ name: 'cube.obj', bytes }, { to: 'glb' }));
  conversions.push(duration);
  output = files[0].bytes;
}

const initializations = [];
for (let index = 0; index < iterations; index += 1) {
  const [duration, assimp] = await time(() => createAssimp());
  initializations.push(duration);
  assimp.dispose();
}

const batchTargets = [{ to: 'glb' }, { to: 'stl', exportOptions: { binary: true } }, { to: 'assjson' }];
const batchAssimp = await createAssimp();
const singularDurations = [];
const pluralDurations = [];
let pluralOutputs;
try {
  for (let index = 0; index < iterations; index += 1) {
    const [singularDuration, singular] = await time(async () =>
      Promise.all(
        batchTargets.map(async ({ to, exportOptions }) => ({
          format: to,
          ...(await batchAssimp.convert(
            { name: 'cube.obj', bytes },
            exportOptions === undefined ? { to } : { to, exportOptions },
          )),
        })),
      ),
    );
    const [pluralDuration, plural] = await time(() =>
      batchAssimp.convertFormats({ name: 'cube.obj', bytes }, { targets: batchTargets }),
    );
    assert.deepEqual(plural, singular);
    singularDurations.push(singularDuration);
    pluralDurations.push(pluralDuration);
    pluralOutputs = plural;
  }
} finally {
  batchAssimp.dispose();
}

const restore = (name, descriptor) => {
  if (descriptor === undefined) delete WebAssembly[name];
  else Object.defineProperty(WebAssembly, name, descriptor);
};

const measureAsyncRoute = async (forceReplay) => {
  const suspending = Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending');
  const promising = Object.getOwnPropertyDescriptor(WebAssembly, 'promising');
  if (forceReplay) {
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
  }
  let assimp;
  try {
    assimp = await createAssimp();
    let calls = 0;
    const [duration, result] = await time(() =>
      assimp.convert(
        { name: 'cube-material.obj', bytes: materialCube },
        {
          to: 'glb',
          resolve: async (name) => {
            calls += 1;
            await Promise.resolve();
            return name === 'cube-material.mtl' ? material : undefined;
          },
        },
      ),
    );
    assert.equal(calls, 1);
    return {
      durationMs: Math.round(duration * 1_000) / 1_000,
      resolverCalls: calls,
      outputFnv: fnv64(result.files[0].bytes),
    };
  } finally {
    assimp?.dispose();
    if (forceReplay) {
      restore('Suspending', suspending);
      restore('promising', promising);
    }
  }
};

const hasJspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const asyncResolver = {
  jspi: hasJspi ? await measureAsyncRoute(false) : null,
  replay: await measureAsyncRoute(true),
};
if (asyncResolver.jspi !== null) {
  assert.equal(asyncResolver.jspi.outputFnv, asyncResolver.replay.outputFnv);
}

const report = {
  name: 'cube-obj-to-glb-v1',
  iterations,
  medianMs: median(conversions),
  initMs: median(initializations),
  outputBytes: output.length,
  outputFnv: fnv64(output),
  batch: {
    targets: batchTargets.length,
    singularMedianMs: median(singularDurations),
    pluralMedianMs: median(pluralDurations),
    outputFnvs: pluralOutputs.map(({ files }) => files.map(({ bytes: contents }) => fnv64(contents))),
  },
  asyncResolver,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

// Origin: medians over seven runs of the first production build on macOS
// arm64, 2026-08-23 — convert 0.44 ms, createAssimp 25.6 ms. The gates are
// twice those, which a shared runner clears while a facade regression does not.
const MAX_MEDIAN_MS = Number(process.env['MAX_MEDIAN_MS'] ?? 0.9);
const MAX_INIT_MS = Number(process.env['MAX_INIT_MS'] ?? 50);

const failures = [
  report.medianMs > MAX_MEDIAN_MS && `convert median ${report.medianMs}ms exceeds ${MAX_MEDIAN_MS}ms`,
  report.initMs > MAX_INIT_MS && `createAssimp median ${report.initMs}ms exceeds ${MAX_INIT_MS}ms`,
].filter(Boolean);
if (failures.length > 0) throw new Error(failures.join('; '));
