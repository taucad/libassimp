import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fnv64 } from '../tests/fnv64.mjs';

// Self-referencing import: the package's own `exports` map resolves this to
// `dist/index.mjs`, so the benchmark measures exactly what ships.
const benchmarkEntry = process.env['LIBASSIMP_BENCH_ENTRY'];
const backend = process.env['LIBASSIMP_BENCH_BACKEND'];
const legacyWasm = process.env['LIBASSIMP_BENCH_LEGACY_WASM'];
if (backend !== undefined && backend !== 'native' && backend !== 'wasm') {
  throw new Error('LIBASSIMP_BENCH_BACKEND must be native or wasm');
}
if (legacyWasm !== undefined && (legacyWasm !== '1' || backend !== 'wasm')) {
  throw new Error('LIBASSIMP_BENCH_LEGACY_WASM=1 requires the Wasm benchmark');
}
const entry = await import(benchmarkEntry ? pathToFileURL(resolve(benchmarkEntry)).href : 'libassimp');
const createAssimp = (options = {}) =>
  entry.createAssimp(backend === undefined ? options : { ...options, backend });
const benchmarkAssimp = backend === undefined ? undefined : await createAssimp();
const convert = benchmarkAssimp?.convert.bind(benchmarkAssimp) ?? entry.convert;

// Generated from Tau's replicad/helical-gear example with:
// pnpm nx run cli:tau -- export libs/tau-examples/src/kernels/replicad/helical-gear/main.ts --ext=glb --output=helical-gear.glb
const bytes = new Uint8Array(readFileSync(new URL('./fixtures/helical-gear.glb', import.meta.url)));
const iterations = 15;
const dependencySidecars = [1, 8, 32];
const encoder = new TextEncoder();

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
await convert({ name: 'helical-gear.glb', bytes }, { to: 'glb' });

const conversions = [];
let output;
for (let index = 0; index < iterations; index += 1) {
  const [duration, { files }] = await time(() => convert({ name: 'helical-gear.glb', bytes }, { to: 'glb' }));
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
            { name: 'helical-gear.glb', bytes },
            exportOptions === undefined ? { to } : { to, exportOptions },
          )),
        })),
      ),
    );
    const [pluralDuration, plural] = await time(() =>
      batchAssimp.convertFormats({ name: 'helical-gear.glb', bytes }, { targets: batchTargets }),
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

const dependencyFixture = (count) => {
  const names = Array.from({ length: count }, (_, index) => `sidecar-${String(index).padStart(2, '0')}.mtl`);
  const source = [
    'o dependency-heavy',
    'v 0 0 0',
    'v 1 0 0',
    'v 0 1 0',
    ...names.flatMap((name, index) => [`mtllib ${name}`, `usemtl material-${index}`, 'f 1 2 3']),
  ].join('\n');
  return {
    files: new Map(
      names.map((name, index) => [name, encoder.encode(`newmtl material-${index}\nKd 1 0 0\n`)]),
    ),
    input: { name: 'dependency-heavy.obj', bytes: encoder.encode(source) },
    names,
  };
};

const measureResolverRoute = async (route) => {
  const forceReplay = route === 'replay';
  const suspending = Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending');
  const promising = Object.getOwnPropertyDescriptor(WebAssembly, 'promising');
  if (forceReplay) {
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
  }
  let assimp;
  try {
    const expectedBackend = route === 'native' ? 'native' : 'wasm';
    assimp = await entry.createAssimp({ backend: expectedBackend });
    const actualBackend = legacyWasm === '1' && assimp.backend === undefined ? 'wasm' : assimp.backend;
    assert.equal(actualBackend, expectedBackend);
    const samples = [];
    for (const sidecars of dependencySidecars) {
      const fixture = dependencyFixture(sidecars);
      const requested = [];
      const [duration, result] = await time(() =>
        assimp.convert(fixture.input, {
          to: 'glb',
          resolve: async (name) => {
            requested.push(name);
            await Promise.resolve();
            return fixture.files.get(name);
          },
        }),
      );
      assert.deepEqual(requested, fixture.names);
      samples.push({
        sidecars,
        durationMs: Math.round(duration * 1_000) / 1_000,
        resolverCalls: requested.length,
        outputBytes: result.files[0].bytes.length,
        outputFnv: fnv64(result.files[0].bytes),
      });
    }
    return samples;
  } finally {
    assimp?.dispose();
    if (forceReplay) {
      restore('Suspending', suspending);
      restore('promising', promising);
    }
  }
};

const hasJspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const resolverBackend = backend ?? 'wasm';
// The packed API intentionally exposes no import-attempt counter. Native tests
// gate its one-import invariant; this report gates names, counts, and bytes.
const dependencyResolver = {
  name: 'obj-mtl-sidecars-v1',
  sidecars: dependencySidecars,
  replayWorstCaseImports: dependencySidecars.map((count) => count + 1),
  routes: {
    native: resolverBackend === 'native' ? await measureResolverRoute('native') : null,
    jspi: resolverBackend === 'wasm' && hasJspi ? await measureResolverRoute('jspi') : null,
    replay: resolverBackend === 'wasm' ? await measureResolverRoute('replay') : null,
  },
};
if (dependencyResolver.routes.jspi !== null) {
  const observable = ({ sidecars, resolverCalls, outputBytes, outputFnv }) => ({
    sidecars,
    resolverCalls,
    outputBytes,
    outputFnv,
  });
  assert.deepEqual(
    dependencyResolver.routes.jspi.map(observable),
    dependencyResolver.routes.replay.map(observable),
  );
}

const report = {
  name: 'helical-gear-glb-to-glb-v1',
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
  dependencyResolver,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

// Origin: medians over seven runs of the Tau CLI helical-gear fixture on macOS
// arm64, 2026-08-25 — convert 47.651 ms, createAssimp 25.593 ms. The gates are
// rounded to about twice those local measurements.
const MAX_MEDIAN_MS = Number(process.env['MAX_MEDIAN_MS'] ?? 100);
const MAX_INIT_MS = Number(process.env['MAX_INIT_MS'] ?? 50);

const failures = [
  report.medianMs > MAX_MEDIAN_MS && `convert median ${report.medianMs}ms exceeds ${MAX_MEDIAN_MS}ms`,
  report.initMs > MAX_INIT_MS && `createAssimp median ${report.initMs}ms exceeds ${MAX_INIT_MS}ms`,
].filter(Boolean);
benchmarkAssimp?.dispose();
if (failures.length > 0) throw new Error(failures.join('; '));
