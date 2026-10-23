// USD performance and memory benchmark, compared against recorded baselines.
//
//   node bench/usd.mjs [--backend wasm|native] [--output report.json]
//
// Each workload runs in its own child process, so peak RSS and the Wasm
// linear-memory high-water mark belong to that workload alone. Timings are
// reported both raw and as a ratio to a calibration conversion (the helical
// gear GLB round trip) measured in the same process: a ratio survives the
// runner-to-runner speed spread that makes absolute milliseconds useless as
// a gate. `scripts/compare-baselines.mjs` gates the report against
// `bench/baselines.json`; `scripts/record-baselines.mjs` moves the baselines.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { fnv64 } from '../tests/fnv64.mjs';
import { usdaGrid, usdSidecarScene } from '../tests/generate-usd-fixture.mjs';

const script = fileURLToPath(import.meta.url);
const round = (value) => Math.round(value * 1_000) / 1_000;
const median = (values) => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];

// Origin: a 512 x 512 grid (262,144 vertices, about 13 MB of USDA) is large
// enough that parsing, triangulation and the writers dominate, and small
// enough that a 2-vCPU runner finishes every workload in well under a minute.
const GRID_SIDE = 512;
const ITERATIONS = 5;

/** Each workload prepares its input (untimed), then converts it. */
const WORKLOADS = {
  'usda-grid-to-usdz': { to: 'usdz', input: async () => [{ name: 'grid.usda', bytes: usdaGrid(GRID_SIDE) }] },
  'usda-grid-to-usdc': { to: 'usdc', input: async () => [{ name: 'grid.usda', bytes: usdaGrid(GRID_SIDE) }] },
  'usdc-grid-to-glb': {
    to: 'glb',
    needs: ['usdc'],
    input: async (assimp) => {
      const { files } = await assimp.convert(
        { name: 'grid.usda', bytes: usdaGrid(GRID_SIDE) },
        { to: 'usdc' },
      );
      return [{ name: 'grid.usdc', bytes: files[0].bytes }];
    },
  },
  'usdz-grid-to-glb': {
    to: 'glb',
    needs: ['usdz'],
    input: async (assimp) => {
      const { files } = await assimp.convert(
        { name: 'grid.usda', bytes: usdaGrid(GRID_SIDE) },
        { to: 'usdz' },
      );
      return [{ name: 'grid.usdz', bytes: files[0].bytes }];
    },
  },
  'glb-gear-to-usdz': {
    to: 'usdz',
    input: async () => [
      {
        name: 'helical-gear.glb',
        bytes: new Uint8Array(readFileSync(new URL('./fixtures/helical-gear.glb', import.meta.url))),
      },
    ],
  },
  'usda-sidecars-to-usdz': {
    to: 'usdz',
    input: async () => {
      const scene = usdSidecarScene();
      return [scene.root, ...[...scene.sidecars].map(([name, bytes]) => ({ name, bytes }))];
    },
  },
};

const sample = async (backend, workloadName, entryPath) => {
  const workload = WORKLOADS[workloadName];
  const entry = await import(entryPath ? pathToFileURL(resolve(entryPath)).href : 'libassimp');
  const memoryBytesKey = Symbol.for('libassimp.memoryBytes');
  const gear = new Uint8Array(readFileSync(new URL('./fixtures/helical-gear.glb', import.meta.url)));

  // The calibration instance is separate, so it cannot raise the workload's memory high-water mark.
  const calibration = await entry.createAssimp({ backend });
  await calibration.convert({ name: 'helical-gear.glb', bytes: gear }, { to: 'glb' });
  const calibrationSamples = [];
  for (let index = 0; index < ITERATIONS * 3; index += 1) {
    const started = performance.now();
    await calibration.convert({ name: 'helical-gear.glb', bytes: gear }, { to: 'glb' });
    calibrationSamples.push(performance.now() - started);
  }
  calibration.dispose();

  const assimp = await entry.createAssimp({ backend });
  const exportIds = new Set(assimp.formats.export.map(({ id }) => id));
  const missing = [workload.to, ...(workload.needs ?? [])].filter((id) => !exportIds.has(id));
  if (missing.length > 0) {
    assimp.dispose();
    return { skipped: `export ${missing.join(', ')} unavailable` };
  }
  const [root, ...sidecars] = await workload.input(assimp);
  const files = new Map(sidecars.map(({ name, bytes }) => [name, bytes]));
  const resolveFile = files.size === 0 ? undefined : async (name) => files.get(name.replace(/^\.\//, ''));
  const convert = () =>
    assimp.convert(
      root,
      resolveFile === undefined ? { to: workload.to } : { to: workload.to, resolve: resolveFile },
    );

  let output = await convert();
  const durations = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    output = await convert();
    durations.push(performance.now() - started);
  }
  const memoryBytes = assimp[memoryBytesKey]?.();
  assimp.dispose();
  const medianMs = median(durations);
  const calibrationMs = median(calibrationSamples);
  return {
    medianMs: round(medianMs),
    calibrationMs: round(calibrationMs),
    ratio: Math.round((medianMs / calibrationMs) * 10_000) / 10_000,
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    inputBytes: root.bytes.length + [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    outputs: output.files.map(({ name, bytes }) => ({ name, bytes: bytes.length, fnv: fnv64(bytes) })),
  };
};

const { values } = parseArgs({
  options: {
    backend: { type: 'string', multiple: true },
    output: { type: 'string' },
    sample: { type: 'string' },
    workload: { type: 'string', multiple: true },
  },
});
const entryPath = process.env['LIBASSIMP_BENCH_ENTRY'];

if (values.sample !== undefined) {
  const [backend, workloadName] = values.sample.split(':');
  assert(backend === 'native' || backend === 'wasm', `unknown backend ${backend}`);
  assert(workloadName in WORKLOADS, `unknown workload ${workloadName}`);
  process.stdout.write(`${JSON.stringify(await sample(backend, workloadName, entryPath))}\n`);
  process.exit(0);
}

const backends = values.backend ?? ['wasm', 'native'];
const workloads = values.workload ?? Object.keys(WORKLOADS);
const results = {};
for (const workloadName of workloads) {
  assert(workloadName in WORKLOADS, `unknown workload ${workloadName}`);
  results[workloadName] = {};
  for (const backend of backends) {
    const child = spawnSync(process.execPath, [script, '--sample', `${backend}:${workloadName}`], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, `${backend}:${workloadName} failed\n${child.stderr}`);
    results[workloadName][backend] = JSON.parse(child.stdout);
  }
}

const report = {
  name: 'usd-v1',
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  gridSide: GRID_SIDE,
  iterations: ITERATIONS,
  workloads: results,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (values.output !== undefined) writeFileSync(values.output, json);
process.stdout.write(json);
