#!/usr/bin/env node
// Per-format performance matrix: every compiled importer that has a fixture,
// crossed with every export target, on one backend.
//
//   node bench/matrix.mjs --backend wasm|native --tier small|large --out matrix.json
//       [--build <name>=<entry.mjs>[,addon=<libassimp.node>][,rev=<git sha>]]...
//       [--runs N] [--side N] [--inputs <dir>] [--filter <regex>] [--shard i/n] [--models <dir>]
//
// Without --build the package's own entry (dist/, so `pnpm run build` first) is
// measured as the build "local". With two builds, for example `base` and `pr`,
// the builds run interleaved on the same machine, alternating which goes first,
// and `bench/matrix-report.mjs` turns the report into a delta table.
//
// Small tier: the fixtures of tests/format-fixtures.mjs, each converted to every export target. One child process per fixture and
// build; every cell gets a fresh instance (so a fresh Wasm linear memory), one
// warm-up conversion and N timed ones, and on Linux the process's peak-RSS
// counter is reset before the cell, so memory figures belong to that cell.
//
// Large tier: side x side grids (bench/matrix-inputs.mjs) of every mesh format,
// each converted to GLB, the GLB grid converted to every mesh format, and
// the USDA grid to USDZ and USDC, and the helical gear (the calibration model,
// 10 MB of GLB) to every export target. One child process per cell, build and run.
//
// Per cell and build the report holds the median wall time of the timed
// conversions, that median as a ratio to the helical-gear GLB round trip
// measured by the same build in the same job (the calibration bench/usd.mjs
// uses), the Wasm linear-memory high-water mark (memory.buffer.byteLength,
// which never shrinks), peak RSS, output bytes and a SHA-256 over every output
// file. A cell is `ok`, `rejected` (an AssimpError, which is a clean failure)
// or `crash` (any other throw, a signal, a non-zero exit or a timeout).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { IMPORTS } from '../tests/format-fixtures.mjs';
import { DERIVED, GENERATED, GENERATOR_VERSION, fileSha256, writeGenerated } from './matrix-inputs.mjs';

export const SCHEMA = 'libassimp-format-matrix-v1';
const script = fileURLToPath(import.meta.url);
const repository = fileURLToPath(new URL('..', import.meta.url));
const gear = fileURLToPath(new URL('./fixtures/helical-gear.glb', import.meta.url));
const memoryBytesKey = Symbol.for('libassimp.memoryBytes');

// Origin: five timed runs after one warm-up keep a small-tier median stable to
// a few percent on a shared 4-vCPU runner; the large tier's conversions run
// for seconds, so three runs of one conversion each bound its cost.
const TIERS = {
  small: { runs: 5, warmup: 1, timeoutMs: 10 * 60_000 },
  large: { runs: 3, warmup: 0, timeoutMs: 15 * 60_000 },
};
// Origin: the 1024 x 1024 grid of the program plan (about one million vertices).
const LARGE_SIDE = 1024;
// The same calibration as bench/usd.mjs: a warm-up, then fifteen timed runs.
const CALIBRATION_RUNS = 15;

const median = (values) => {
  const sorted = values.filter((value) => value != null).toSorted((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};
const round = (value) => (value == null ? null : Math.round(value * 1_000) / 1_000);

// ---------------------------------------------------------------------------
// Worker: runs inside the child process.

const peakRss = {
  // Linux resets VmHWM to the current RSS on write of 5 to clear_refs (since 4.0).
  reset: () => {
    try {
      writeFileSync('/proc/self/clear_refs', '5');
      return true;
    } catch {
      return false;
    }
  },
  read: () => {
    try {
      const status = readFileSync('/proc/self/status', 'utf8');
      const field = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'mu').exec(status)?.[1]) * 1024;
      if (status.includes('VmHWM:'))
        return { bytes: field('VmHWM'), current: field('VmRSS'), probe: 'VmHWM' };
    } catch {
      // Not Linux: fall back to the process-lifetime peak.
    }
    return {
      bytes: process.resourceUsage().maxRSS * 1024,
      current: process.memoryUsage().rss,
      probe: 'maxRSS',
    };
  },
};

const digest = (files) => {
  const hash = createHash('sha256');
  for (const { name, bytes } of files) {
    hash.update(`${name}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
};

const classify = (error) => ({
  // AssimpError carries a taxonomy code and is a clean, reported failure.
  status: typeof error?.code === 'string' && error?.name === 'AssimpError' ? 'rejected' : 'crash',
  code: error?.code ?? error?.name ?? null,
  message: String(error?.message ?? error).slice(0, 300),
});

const loadFiles = (paths) =>
  paths.map((path) => ({ name: basename(path), bytes: new Uint8Array(readFileSync(path)) }));

// A disposed instance drains asynchronously; let it, then collect its linear memory.
const settle = async () => {
  await new Promise((resolveTick) => setImmediate(resolveTick));
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  globalThis.gc?.();
  globalThis.gc?.();
};

const runWorker = async (spec) => {
  // Every cell instantiates afresh, so it starts from the initial linear memory;
  // compiling the same module once per process keeps that affordable.
  const compile = WebAssembly.compile;
  let compiled;
  WebAssembly.compile = async (bytes) => (compiled ??= await compile.call(WebAssembly, bytes));

  const emit = (value) => writeSync(1, `${JSON.stringify(value)}\n`);
  const specifier =
    spec.entry.startsWith('.') || isAbsolute(spec.entry)
      ? pathToFileURL(resolve(spec.entry)).href
      : spec.entry;
  const entry = await import(specifier);
  const create = async () => {
    const assimp = await entry.createAssimp({ backend: spec.backend });
    assert.equal(assimp.backend, spec.backend, `asked for ${spec.backend}, got ${assimp.backend}`);
    return assimp;
  };

  if (spec.op === 'probe') {
    const assimp = await create();
    emit({
      probe: {
        buildIdentity: assimp.buildIdentity ?? null,
        imports: assimp.formats.import.map(({ id }) => id),
        exports: assimp.formats.export.map(({ id }) => id),
      },
    });
    assimp.dispose();
    return;
  }

  if (spec.op === 'calibrate') {
    const assimp = await create();
    const input = { name: 'helical-gear.glb', bytes: new Uint8Array(readFileSync(gear)) };
    await assimp.convert(input, { to: 'glb' });
    const samples = [];
    for (let index = 0; index < CALIBRATION_RUNS; index += 1) {
      const started = performance.now();
      await assimp.convert(input, { to: 'glb' });
      samples.push(round(performance.now() - started));
    }
    assimp.dispose();
    emit({ calibration: samples });
    return;
  }

  if (spec.op === 'derive') {
    const assimp = await create();
    for (const { files, to, out } of spec.derive) {
      const input = loadFiles(files);
      const { files: outputs } = await assimp.convert(input.length === 1 ? input[0] : input, { to });
      writeFileSync(out, outputs[0].bytes);
      for (const extra of outputs.slice(1)) writeFileSync(join(dirname(out), extra.name), extra.bytes);
      emit({ derived: out, sidecars: outputs.slice(1).map(({ name }) => name) });
    }
    assimp.dispose();
    return;
  }

  assert.equal(spec.op, 'cells');
  for (const cell of spec.cells) {
    const input = loadFiles(cell.files);
    await settle();
    const resetOk = peakRss.reset();
    const before = peakRss.read();
    let assimp;
    const result = {
      cell: cell.id,
      status: 'ok',
      durations: [],
      inputBytes: input.reduce((sum, { bytes }) => sum + bytes.byteLength, 0),
    };
    try {
      const started = performance.now();
      assimp = await create();
      result.createMs = round(performance.now() - started);
      const convert = () => assimp.convert(input.length === 1 ? input[0] : input, { to: cell.to });
      for (let index = 0; index < spec.warmup; index += 1) await convert();
      const shas = new Set();
      let output;
      const cpu = process.cpuUsage();
      for (let index = 0; index < spec.runs; index += 1) {
        const started = performance.now();
        output = await convert();
        result.durations.push(round(performance.now() - started));
        shas.add(digest(output.files));
      }
      const used = process.cpuUsage(cpu);
      result.cpuMs = round((used.user + used.system) / 1_000 / spec.runs);
      result.outputBytes = output.files.reduce((sum, { bytes }) => sum + bytes.byteLength, 0);
      result.outputFiles = output.files.length;
      result.sha256 = [...shas][0];
      // Exporters that stamp the time write different bytes on every run.
      result.stable = shas.size === 1;
    } catch (error) {
      Object.assign(result, classify(error));
    }
    result.wasmHeapBytes = assimp?.[memoryBytesKey]?.() ?? null;
    const rss = peakRss.read();
    result.peakRssBytes = rss.bytes;
    // The RSS the cell started from: what earlier cells left resident.
    result.startRssBytes = before.current;
    result.rssProbe = resetOk ? rss.probe : 'maxRSS';
    assimp?.dispose();
    emit(result);
  }
};

// ---------------------------------------------------------------------------
// Orchestrator.

const describeExit = (child) =>
  child.error?.code === 'ETIMEDOUT'
    ? 'timed out'
    : `exit ${child.status ?? ''}${child.signal ? ` signal ${child.signal}` : ''}: ${(child.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`;

const spawnWorker = (build, spec, timeoutMs) => {
  const env = { ...process.env };
  if (build.addon) env['NAPI_RS_NATIVE_LIBRARY_PATH'] = build.addon;
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=8192',
      script,
      '--worker',
      JSON.stringify({ ...spec, entry: build.entry }),
    ],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
  );
  const lines = (child.stdout || '')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  return { child, lines, ok: child.status === 0 && !child.error };
};

const single = (build, spec, key) => {
  const { child, lines, ok } = spawnWorker(build, spec, spec.op === 'probe' ? 120_000 : 300_000);
  const line = lines.find((value) => key in value);
  if (!ok || !line) throw new Error(`${build.name} ${spec.op} failed: ${describeExit(child)}`);
  return line;
};

/** Runs cells in one child; when the child dies, the first unfinished cell crashed and the rest resume. */
const runCells = (build, cells, options) => {
  const results = new Map();
  let pending = cells;
  while (pending.length > 0) {
    const { child, lines } = spawnWorker(
      build,
      { op: 'cells', backend: options.backend, cells: pending, runs: options.runs, warmup: options.warmup },
      options.timeoutMs,
    );
    for (const line of lines) if (line.cell) results.set(line.cell, line);
    pending = pending.filter(({ id }) => !results.has(id));
    if (pending.length > 0) {
      const [culprit, ...rest] = pending;
      results.set(culprit.id, {
        cell: culprit.id,
        status: 'crash',
        code: null,
        message: describeExit(child),
        durations: [],
      });
      pending = rest;
    }
  }
  return results;
};

const parseBuild = (value) => {
  const match = /^([\w.-]+)=(.+)$/u.exec(value);
  assert(match, `--build must look like name=entry[,addon=path][,rev=sha], got ${value}`);
  const [entry, ...extras] = match[2].split(',');
  const build = {
    name: match[1],
    entry: isAbsolute(entry) || entry.startsWith('.') ? resolve(entry) : entry,
  };
  for (const extra of extras) {
    const [key, value] = extra.split('=');
    assert(key === 'addon' || key === 'rev', `unknown build option ${key}`);
    if (key === 'addon') build.addon = resolve(value);
    else build.rev = value;
  }
  return build;
};

const smallCells = (exports, models) => {
  const fixtures = IMPORTS.filter(([, , outcome]) => outcome !== 'error').map(([id, files]) => ({
    from: id,
    files: files.map((file) => join(models, file)),
  }));
  return fixtures.map(({ from, files }) =>
    exports.map((to) => ({ id: `${from} -> ${to}`, from, to, files })),
  );
};

/** Generates (or reuses) the large inputs and derives the converted ones with `producer`. */
const prepareInputs = (directory, side, { producer, backend }) => {
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const fresh = manifest?.generator === GENERATOR_VERSION && manifest?.side === side;
  const files = fresh ? manifest.files : writeGenerated(directory, side);
  const derivedBy = fresh ? (manifest.derivedBy ?? {}) : {};
  const missing = Object.entries(DERIVED).filter(([, { file }]) => !(file in files));
  if (missing.length > 0) {
    const { lines } = spawnWorker(
      producer,
      {
        op: 'derive',
        backend,
        derive: missing.map(([, { from, file }]) => ({
          files: GENERATED[from].files.map((name) => join(directory, name)),
          to: file.split('.').pop(),
          out: join(directory, file),
        })),
      },
      TIERS.large.timeoutMs,
    );
    for (const { derived, sidecars } of lines.filter((line) => line.derived)) {
      for (const name of [basename(derived), ...sidecars]) {
        files[name] = fileSha256(join(directory, name));
        derivedBy[name] = `${producer.name} (${backend})`;
      }
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ generator: GENERATOR_VERSION, side, files, derivedBy }, null, 2)}\n`,
  );
  const unavailable = Object.values(DERIVED)
    .map(({ file }) => file)
    .filter((file) => !(file in files));
  return { files, derivedBy, ...(unavailable.length > 0 ? { unavailable } : {}) };
};

// The large grid goes to every mesh format the plan names; the remaining
// targets are covered at scale by the helical gear and per fixture by the
// small tier. Origin: at 512 x 512 natively, GLB to STEP alone took 8.7 s,
// wrote 760 MB and peaked at 2.5 GB RSS, which a 1024 x 1024 grid would
// multiply by four on every run of both builds.
const LARGE_TARGETS = ['dae', 'fbx', 'gltf', 'obj', 'ply', 'stl', 'usda', 'usdc', 'usdz'];

const largeCells = (exports, { directory, side, inputs }) => {
  const prefix = `grid${side}`;
  const sources = Object.fromEntries([
    ...Object.entries(GENERATED).map(([format, { files }]) => [format, files]),
    ...Object.entries(DERIVED).map(([format, { file }]) => [format, [file]]),
  ]);
  const cell = (from, to) => ({
    id: `${prefix}.${from} -> ${to}`,
    from: `${prefix}.${from}`,
    to,
    files: sources[from].map((name) => join(directory, name)),
  });
  const available = (format) => sources[format].every((name) => name in inputs.files);
  return [
    ...Object.keys(sources)
      .filter(available)
      .map((format) => cell(format, 'glb')),
    ...LARGE_TARGETS.filter((to) => exports.includes(to)).map((to) => cell('glb', to)),
    ...['usdz', 'usdc']
      .filter((to) => available('usda') && exports.includes(to))
      .map((to) => cell('usda', to)),
    // The real-world model the calibration and bench/usd.mjs use: 376,242 vertices.
    ...exports.map((to) => ({ id: `helical gear -> ${to}`, from: 'helical gear', to, files: [gear] })),
  ].map((value) => [value]);
};

/** Merges one cell's per-run results into the reported figures. */
const aggregate = (results, calibrationMs) => {
  const crashed = results.find(({ status }) => status === 'crash');
  const rejected = results.find(({ status }) => status === 'rejected');
  const failure = crashed ?? rejected;
  if (failure) return { status: failure.status, code: failure.code, message: failure.message };
  const durations = results.flatMap(({ durations }) => durations);
  const medianMs = median(durations);
  const shas = new Set(results.map(({ sha256 }) => sha256));
  return {
    status: 'ok',
    runs: durations.length,
    medianMs: round(medianMs),
    minMs: round(Math.min(...durations)),
    maxMs: round(Math.max(...durations)),
    ratio: calibrationMs ? Math.round((medianMs / calibrationMs) * 10_000) / 10_000 : null,
    cpuMs: round(median(results.map(({ cpuMs }) => cpuMs))),
    createMs: round(median(results.map(({ createMs }) => createMs))),
    wasmHeapBytes: results.some(({ wasmHeapBytes }) => wasmHeapBytes != null)
      ? Math.max(...results.map(({ wasmHeapBytes }) => wasmHeapBytes ?? 0))
      : null,
    peakRssBytes: median(results.map(({ peakRssBytes }) => peakRssBytes)),
    startRssBytes: median(results.map(({ startRssBytes }) => startRssBytes)),
    rssProbe: results[0].rssProbe,
    inputBytes: results[0].inputBytes,
    outputBytes: results[0].outputBytes,
    outputFiles: results[0].outputFiles,
    sha256: results[0].sha256,
    stable: shas.size === 1 && results.every(({ stable }) => stable),
  };
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      build: { type: 'string', multiple: true },
      filter: { type: 'string' },
      inputs: { type: 'string' },
      models: { type: 'string' },
      out: { type: 'string' },
      runs: { type: 'string' },
      shard: { type: 'string' },
      side: { type: 'string' },
      tier: { type: 'string', default: 'small' },
      worker: { type: 'string' },
    },
  });
  if (values.worker !== undefined) {
    await runWorker(JSON.parse(values.worker));
    process.exit(0);
  }
  const { backend, tier } = values;
  assert(backend === 'wasm' || backend === 'native', '--backend must be wasm or native');
  assert(tier in TIERS, '--tier must be small or large');
  const runs = Number(values.runs ?? TIERS[tier].runs);
  assert(Number.isSafeInteger(runs) && runs > 0, '--runs must be a positive integer');
  const side = Number(values.side ?? LARGE_SIDE);
  const builds = (values.build ?? ['local=libassimp']).map(parseBuild);
  assert.equal(new Set(builds.map(({ name }) => name)).size, builds.length, 'build names must be unique');
  const filter = values.filter === undefined ? null : new RegExp(values.filter, 'u');
  const log = (message) => process.stderr.write(`${message}\n`);
  const started = performance.now();

  const meta = {};
  for (const build of builds) {
    const { probe } = single(build, { op: 'probe', backend }, 'probe');
    meta[build.name] = {
      entry: build.entry,
      ...(build.addon ? { addon: build.addon } : {}),
      ...(build.rev ? { rev: build.rev } : {}),
      ...probe,
      calibration: [],
    };
    log(`${build.name}: ${probe.exports.length} export targets, ${probe.imports.length} import formats`);
  }
  // Every build is measured on the union, so an added or removed target shows up as a status change.
  const exports = [...new Set(builds.flatMap(({ name }) => meta[name].exports))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const calibrate = () => {
    for (const build of builds)
      meta[build.name].calibration.push(
        ...single(build, { op: 'calibrate', backend }, 'calibration').calibration,
      );
  };

  let inputs;
  let groups;
  if (tier === 'small') {
    groups = smallCells(exports, resolve(values.models ?? join(repository, 'assimp/test/models')));
  } else {
    const directory = resolve(values.inputs ?? join(repository, '.bench-inputs'));
    const producer = builds.find(({ name }) => name === 'base') ?? builds[0];
    const preparing = performance.now();
    inputs = prepareInputs(directory, side, { producer, backend });
    log(`inputs ready in ${Math.round(performance.now() - preparing)} ms`);
    groups = largeCells(exports, { directory, side, inputs });
  }
  groups = groups
    .map((cells) => cells.filter(({ id }) => !filter || filter.test(id)))
    .filter((cells) => cells.length > 0);
  if (values.shard !== undefined) {
    const [index, count] = values.shard.split('/').map(Number);
    assert(Number.isSafeInteger(count) && index >= 1 && index <= count, '--shard must look like 1/2');
    groups = groups.filter((_, position) => position % count === index - 1);
  }

  calibrate();
  const raw = new Map();
  const record = (build, id, result) => {
    const key = `${build}\0${id}`;
    if (!raw.has(key)) raw.set(key, []);
    raw.get(key).push(result);
  };
  const options = { backend, timeoutMs: TIERS[tier].timeoutMs };
  let turn = 0;
  for (const cells of groups) {
    // Large cells run once per child, so their repetitions interleave the builds too.
    const repetitions = tier === 'small' ? 1 : runs;
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const order = turn % 2 === 0 ? builds : builds.toReversed();
      turn += 1;
      for (const build of order) {
        const results = runCells(build, cells, {
          ...options,
          runs: tier === 'small' ? runs : 1,
          warmup: TIERS[tier].warmup,
        });
        for (const [id, result] of results) record(build.name, id, result);
      }
    }
    log(
      `${cells.length === 1 ? cells[0].id : cells[0].from}: ${cells.length} cell(s) done at ${Math.round((performance.now() - started) / 1_000)} s`,
    );
  }
  calibrate();

  for (const build of builds) {
    const samples = meta[build.name].calibration;
    meta[build.name].calibration = { medianMs: round(median(samples)), samples };
  }
  const report = {
    schema: SCHEMA,
    tier,
    backend,
    runs,
    ...(values.shard === undefined ? {} : { shard: values.shard }),
    ...(tier === 'large' ? { side, inputs } : {}),
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? null,
    node: process.version,
    startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
    durationMs: Math.round(performance.now() - started),
    builds: meta,
    cells: groups.flat().map(({ id, from, to }) => ({
      id,
      from,
      to,
      results: Object.fromEntries(
        builds.map(({ name }) => [
          name,
          aggregate(raw.get(`${name}\0${id}`), meta[name].calibration.medianMs),
        ]),
      ),
    })),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out !== undefined) writeFileSync(values.out, json);
  else process.stdout.write(json);
  const crashes = report.cells.flatMap(({ id, results }) =>
    Object.entries(results)
      .filter(([, { status }]) => status === 'crash')
      .map(([name]) => `${name}: ${id}`),
  );
  log(
    `${report.cells.length} cells in ${Math.round(report.durationMs / 1_000)} s; crashes: ${crashes.length === 0 ? 'none' : crashes.join(', ')}`,
  );
};

await main();
