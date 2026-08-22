import { readFileSync } from 'node:fs';

// Self-referencing import: the package's own `exports` map resolves this to
// `dist/exporter.mjs`, so the benchmark measures exactly what ships.
import { convert } from 'libassimp/exporter';

const bytes = new Uint8Array(readFileSync(new URL('../tests/fixtures/cube.obj', import.meta.url)));
const iterations = 15;

const fnv64 = (input) => {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of input) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0000_0100_0000_01b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

await convert({ name: 'cube.obj', bytes }, { to: 'glb' });
const durations = [];
let output;
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  const { files } = await convert({ name: 'cube.obj', bytes }, { to: 'glb' });
  durations.push(performance.now() - started);
  output = files[0].bytes;
}
durations.sort((left, right) => left - right);

const report = {
  name: 'cube-obj-to-glb-v1',
  iterations,
  medianMs: Math.round(durations[Math.floor(iterations / 2)] * 1_000) / 1_000,
  outputBytes: output.length,
  outputFnv: fnv64(output),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const maximum = Number(process.env['MAX_MEDIAN_MS']);
if (Number.isFinite(maximum) && report.medianMs > maximum) {
  throw new Error(`benchmark median ${report.medianMs}ms exceeds ${maximum}ms`);
}
