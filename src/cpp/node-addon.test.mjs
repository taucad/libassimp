// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const addonPath = process.env.LIBASSIMP_NATIVE_ADDON;
assert(addonPath, 'LIBASSIMP_NATIVE_ADDON is required');
const addon = createRequire(import.meta.url)(addonPath);
assert.deepEqual(
  {
    cancelPlan: typeof addon.cancelPlan,
    pendingName: typeof addon.pendingName,
    supplyPlan: typeof addon.supplyPlan,
  },
  { cancelPlan: 'function', pendingName: 'undefined', supplyPlan: 'undefined' },
  'native resolver close-out surface',
);
if (!addon._coverageStats) {
  assert.deepEqual(Object.keys(addon).toSorted(), [
    'buildIdentity',
    'cancelPlan',
    'destroyPlan',
    'exportFormats',
    'importFormats',
    'napiVersion',
    'packageVersion',
    'preparePlan',
    'runPlan',
    'takePlanResult',
  ]);
}
if (addon._coverageStats) {
  assert.deepEqual(
    { retainedBytes: addon._coverageStats().retainedBytes, stagedBytes: addon._coverageStats().stagedBytes },
    { retainedBytes: 0, stagedBytes: 0 },
  );
}
const capabilityEvidence = JSON.parse(
  await readFile(new URL('../../scripts/assimp-capability-evidence.json', import.meta.url), 'utf8'),
);
const packageManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const { internalCanonicalExportRoutes } = await import('../../dist/generated/assimp-capabilities.mjs');

assert.equal(addon.napiVersion, 8);
assert.equal(addon.buildIdentity, `${process.platform}-${process.arch}-napi8`);
assert.equal(addon.packageVersion, packageManifest.version);
const importFormats = addon.importFormats();
const exportFormats = addon.exportFormats();
assert(importFormats.some(({ id }) => id === 'obj'));
assert(exportFormats.some(({ id }) => id === 'glb2'));
assert.deepEqual(
  importFormats.map(({ id }) => id).toSorted(),
  capabilityEvidence.formats.import.map(({ id }) => id).toSorted(),
  'native importer inventory differs from the generated capability evidence',
);
const expectedExportIds = new Set();
for (const route of internalCanonicalExportRoutes) {
  expectedExportIds.add(route.nativeId);
  for (const choices of Object.values(route.routes ?? {})) {
    for (const nativeId of Object.values(choices)) expectedExportIds.add(nativeId);
  }
}
assert.deepEqual(
  exportFormats.map(({ id }) => id).toSorted(),
  [...expectedExportIds].toSorted((left, right) => left.localeCompare(right)),
  'native exporter inventory differs from the generated capability routes',
);

const models = new URL('../../assimp/test/models/', import.meta.url);
const options = (format = 'glb', nativeId = 'glb2') => ({
  importProperties: [],
  postProcess: 0,
  targets: [{ format, nativeId, properties: [] }],
});
const input = async (relative) => {
  const url = new URL(relative, models);
  const path = fileURLToPath(url);
  return { entry: basename(path), directory: dirname(path), bytes: await readFile(url) };
};

const MISSING = 0;
const FOUND = 1;
const FAILED = 2;
const ABORTED = 3;
const IMPORTING = 1;
const POSTPROCESSING = 2;
const EXPORTING = 3;
const TRIANGULATE = 0x8;
const missingResolver = (_name, settle) => settle(MISSING);
const run = (plan, resolveRequest = missingResolver) => addon.runPlan(plan, resolveRequest);
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
};
const executorIdle = () => {
  const { activeJobs, queuedJobs } = addon._coverageStats();
  return activeJobs === 0 && queuedJobs === 0;
};
const resourceCounts = () => {
  const { activeJobs, outstandingRequests, queuedJobs, retainedBytes, stagedBytes, transientBytes } =
    addon._coverageStats();
  return { activeJobs, outstandingRequests, queuedJobs, retainedBytes, stagedBytes, transientBytes };
};
const noResources = () => {
  const { activeJobs, outstandingRequests, queuedJobs, transientBytes } = resourceCounts();
  return activeJobs === 0 && outstandingRequests === 0 && queuedJobs === 0 && transientBytes === 0;
};
const noStagingResources = () => Object.values(resourceCounts()).every((count) => count === 0);
const directoryResolver =
  (directory, delay = 0) =>
  (name, settle) => {
    const resolve = async () => {
      try {
        settle(FOUND, await readFile(join(directory, basename(name))));
      } catch (error) {
        if (error?.code === 'ENOENT') settle(MISSING);
        else settle(FAILED);
      }
    };
    if (delay === 0) void resolve();
    else setTimeout(() => void resolve(), delay);
  };
const runChild = async (source, environment = {}, nodeArguments = []) => {
  const sanitizerEnvironment = process.env.LIBASSIMP_ASAN_RUNTIME
    ? { DYLD_INSERT_LIBRARIES: process.env.LIBASSIMP_ASAN_RUNTIME }
    : {};
  const child = spawn(process.execPath, [...nodeArguments, '--eval', source], {
    env: { ...process.env, ...sanitizerEnvironment, ...environment },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    error += chunk;
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timeout);
  assert.equal(signal, null, error || 'child process timed out');
  assert.equal(code, 0, error);
};

{
  const box = await input('OBJ/box.obj');
  const source = Uint8Array.from(box.bytes);
  const properties = [
    { name: 'libassimp.bool', kind: 'boolean', value: true },
    { name: 'libassimp.integer', kind: 'integer', value: 2 },
    { name: 'libassimp.number', kind: 'number', value: 0.5 },
    { name: 'libassimp.string', kind: 'string', value: 'value' },
    {
      name: 'libassimp.matrix',
      kind: 'matrix',
      value: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ];
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: source }], {
    ...options(),
    importProperties: properties,
    targets: [{ format: 'glb', nativeId: 'glb2', properties }],
  });
  assert.equal(await run(plan), 1);
  const first = addon.takePlanResult(plan);
  assert(first.ok);
  assert.equal(first.formats[0].files[0].name, 'result.glb');
  assert.equal(Object.getPrototypeOf(first.formats[0].files[0].bytes), Uint8Array.prototype);
  const expected = first.formats[0].files[0].bytes[0];
  first.formats[0].files[0].bytes[0] ^= 0xff;
  assert.equal(addon.takePlanResult(plan).formats[0].files[0].bytes[0], expected);
  addon.destroyPlan(plan);
  addon.destroyPlan(plan);
  assert.throws(() => addon.takePlanResult(plan), /destroyed/);
}

{
  const spider = await input('OBJ/spider.obj');
  const plan = addon.preparePlan(spider.entry, [{ name: spider.entry, bytes: spider.bytes }], options());
  assert.equal(await run(plan, directoryResolver(spider.directory, 5)), 1);
  assert(addon.takePlanResult(plan).ok);
  if (addon._coverageStats) assert.equal(addon._coverageStats(plan).importAttempts, 1);
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib first.mtl\nmtllib second.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl first\nf 1 2 3\n',
  );
  const material = new TextEncoder().encode('newmtl first\nKd 1 0 0\n');
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const plan = addon.preparePlan('multiple.obj', [{ name: 'multiple.obj', bytes }], options());
  assert.equal(
    await run(plan, (name, settle) => {
      requests.push(name);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      setTimeout(() => {
        active -= 1;
        settle(FOUND, material);
      }, 2);
    }),
    1,
  );
  assert.deepEqual(requests, ['first.mtl', 'second.mtl']);
  assert.equal(maximumActive, 1);
  if (addon._coverageStats) assert.equal(addon._coverageStats(plan).importAttempts, 1);
  addon.destroyPlan(plan);
}

if (addon._coverageStats) {
  const names = Array.from({ length: 32 }, (_, index) => `sidecar-${String(index).padStart(2, '0')}.mtl`);
  const source = new TextEncoder().encode(
    [
      'o dependency-heavy',
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      ...names.flatMap((name, index) => [`mtllib ${name}`, `usemtl material-${index}`, 'f 1 2 3']),
    ].join('\n'),
  );
  const materials = new Map(
    names.map((name, index) => [name, new TextEncoder().encode(`newmtl material-${index}\nKd 1 0 0\n`)]),
  );
  const requested = [];
  const plan = addon.preparePlan('dependency-heavy.obj', [{ name: 'dependency-heavy.obj', bytes: source }], {
    ...options(),
    postProcess: TRIANGULATE,
  });
  assert.equal(
    await run(plan, (name, settle) => {
      requested.push(name);
      queueMicrotask(() => settle(FOUND, materials.get(name)));
    }),
    1,
  );
  assert.deepEqual(requested, names);
  const { importAttempts, timings } = addon._coverageStats(plan);
  assert.equal(importAttempts, 1);
  assert(timings, 'coverage phase timings are missing');
  for (const name of ['queueWaitMs', 'resolverWaitMs', 'importMs', 'postProcessMs', 'exportMs', 'totalMs']) {
    assert(Number.isFinite(timings[name]) && timings[name] >= 0, `${name} is not a duration`);
  }
  assert(timings.importObserved);
  assert(timings.postProcessObserved);
  assert(timings.exportObserved);
  assert(timings.resolverWaitMs > 0);
  assert(
    timings.totalMs >=
      timings.queueWaitMs +
        timings.resolverWaitMs +
        timings.importMs +
        timings.postProcessMs +
        timings.exportMs,
  );
  if (process.env.LIBASSIMP_RECORD_CPP_DIAGNOSTICS === '1') {
    console.log(
      `dependency-heavy native diagnostics ${JSON.stringify({ sidecars: names.length, resolverCalls: requested.length, importAttempts, ...timings })}`,
    );
  }
  addon.destroyPlan(plan);
}

{
  const box = await input('OBJ/box.obj');
  const plans = [
    addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options()),
    addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options()),
  ];
  assert.deepEqual(await Promise.all(plans.map((plan) => run(plan))), [1, 1]);
  for (const plan of plans) addon.destroyPlan(plan);
}

{
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  const running = run(plan);
  assert.throws(() => run(plan), /already running/);
  assert.throws(() => addon.takePlanResult(plan), /already running/);
  addon.destroyPlan(plan);
  addon.destroyPlan(plan);
  assert.equal(await running, 1);
}

{
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  let armed = true;
  let reentrant;
  let reentrantError;
  const hook = createHook({
    init(_id, type) {
      if (!armed || type !== 'PROMISE') return;
      armed = false;
      try {
        reentrant = run(plan);
      } catch (error) {
        reentrantError = error;
      }
    },
  });
  hook.enable();
  const running = run(plan);
  hook.disable();
  if (reentrant) await Promise.resolve(reentrant);
  assert.match(reentrantError?.message ?? '', /already running/);
  assert.equal(await running, 1);
  addon.destroyPlan(plan);
}

if (addon._coverageBlockNextExecute) {
  const bytes = new TextEncoder().encode(
    'mtllib completion.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const plan = addon.preparePlan('completion.obj', [{ name: 'completion.obj', bytes }], options());
  let promiseId;
  let nestedRun;
  let nestedError;
  const hook = createHook({
    init(id, type) {
      if (promiseId === undefined && type === 'PROMISE') promiseId = id;
    },
    promiseResolve(id) {
      if (id !== promiseId) return;
      try {
        nestedRun = run(plan, (_name, settle) => settle(FAILED));
      } catch (error) {
        nestedError = error;
      }
    },
  });
  addon._coverageBlockNextExecute();
  hook.enable();
  const running = run(plan);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its completion gate');
  addon._coverageReleaseExecute();
  assert.equal(await running, 1);
  hook.disable();
  let firstResult;
  let firstResultError;
  try {
    firstResult = addon.takePlanResult(plan);
  } catch (error) {
    firstResultError = error;
  }
  if (nestedRun) await Promise.resolve(nestedRun);
  assert.match(nestedError?.message ?? '', /already running/);
  assert.equal(firstResultError, undefined);
  assert(firstResult.ok);
  assert.equal(await run(plan), 1);
  assert(addon.takePlanResult(plan).ok);
  addon.destroyPlan(plan);
}

assert.throws(() => addon.preparePlan('', [], {}), /postProcess/);
assert.throws(() => addon.preparePlan(), /expects entryName/);
assert.throws(() => addon.runPlan(), /expects a plan/);
assert.throws(() => addon.cancelPlan(), /expects a plan/);
assert.throws(() => addon.takePlanResult(), /expects a plan/);
assert.throws(() => addon.destroyPlan(), /expects a plan/);
assert.throws(() => addon.runPlan({}, missingResolver), /opaque conversion plan/);
assert.throws(() => addon.cancelPlan({}), /opaque conversion plan/);
{
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  assert.throws(() => addon.runPlan(plan), /resolveRequest must be a function/);
  assert.throws(() => addon.runPlan(plan, {}), /resolveRequest must be a function/);
  addon.destroyPlan(plan);
}
if (addon._coverageWrongPlan) {
  const wrong = addon._coverageWrongPlan();
  assert.throws(() => addon.runPlan(wrong, missingResolver), /opaque conversion plan/);
  assert.throws(() => addon.cancelPlan(wrong), /opaque conversion plan/);
}
if (addon._coverageEmptyResult)
  assert.equal(addon._coverageEmptyResult().formats[0].files[0].bytes.length, 0);

{
  const box = await input('OBJ/box.obj');
  const prepareProperty = (property) =>
    addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], {
      ...options(),
      importProperties: [property],
    });
  for (const [property, message] of [
    [{ name: 'x', kind: 'boolean', value: 1 }, /must be boolean/],
    [{ name: 'x', kind: 'integer', value: '1' }, /must be a number/],
    [{ name: 'x', kind: 'integer', value: 1.5 }, /must be an int32/],
    [{ name: 'x', kind: 'integer', value: 2_147_483_648 }, /must be an int32/],
    [{ name: 'x', kind: 'number', value: '1' }, /must be a number/],
    [{ name: 'x', kind: 'number', value: Number.NaN }, /fit finite ai_real/],
    [{ name: 'x', kind: 'number', value: 1e300 }, /fit finite ai_real/],
    [{ name: 'x', kind: 'string', value: 1 }, /must be a string/],
    [{ name: 'x', kind: 'unknown', value: 1 }, /unknown property kind/],
    [{ name: 'x', kind: 'matrix', value: [] }, /needs 16 numbers/],
    [{ name: 'x', kind: 'matrix', value: Array(16).fill('x') }, /needs 16 numbers/],
    [
      { name: 'x', kind: 'matrix', value: [Number.NaN, ...Array(15).fill(0)] },
      /needs 16 finite ai_real numbers/,
    ],
    [{ name: 'x', kind: 'matrix', value: [1e300, ...Array(15).fill(0)] }, /finite ai_real/],
  ]) {
    assert.throws(() => prepareProperty(property), message);
  }
  assert.throws(
    () => addon.preparePlan(box.entry, [{ name: box.entry, bytes: [] }], options()),
    /must be a Uint8Array/,
  );
  assert.throws(() => addon.preparePlan(box.entry, [null], options()), /must be an object/);
  assert.throws(() => addon.preparePlan(box.entry, [[]], options()), /must be an object/);
  assert.throws(() => addon.preparePlan(box.entry, [new Uint8Array()], options()), /must be an object/);
  assert.throws(() => addon.preparePlan(box.entry, {}, options()), /must be an array/);
  assert.throws(
    () => addon.preparePlan(box.entry, [{ name: box.entry, bytes: new Uint16Array() }], options()),
    /must be a Uint8Array/,
  );
  assert.throws(() => addon.preparePlan(1, [], options()), /must be a string/);
  assert.throws(
    () =>
      addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], {
        ...options(),
        postProcess: -1,
      }),
    /must be a uint32/,
  );
}

{
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(
    box.entry,
    [{ name: box.entry, bytes: box.bytes }],
    options('missing', 'missing'),
  );
  assert.equal(await run(plan), 2);
  assert.deepEqual(addon.takePlanResult(plan), {
    ok: false,
    code: 'UNSUPPORTED_FORMAT',
    message: "Unsupported export format 'missing'.",
    formatIndex: 0,
    format: 'missing',
    formats: [],
  });
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib missing.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const plan = addon.preparePlan('missing.obj', [{ name: 'missing.obj', bytes }], options());
  assert.equal(await run(plan), 1);
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib missing.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const plan = addon.preparePlan('missing.obj', [{ name: 'missing.obj', bytes }], options());
  assert.equal(await run(plan, (_name, settle) => settle(FAILED)), 2);
  assert.equal(addon.takePlanResult(plan).code, 'RESOLVE_FAILED');
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib pending.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const material = new TextEncoder().encode('newmtl material\nKd 1 0 0\n');
  const plan = addon.preparePlan('pending.obj', [{ name: 'pending.obj', bytes }], options());
  let lateSettle;
  const running = run(plan, (_name, settle) => {
    lateSettle = settle;
  });
  await waitFor(() => lateSettle !== undefined, 'resolver request was not delivered');
  if (addon._coverageStats) {
    assert.equal(addon._coverageStats().outstandingRequests, 1);
    assert.equal(addon._coverageStats().transientBytes, 0);
  }
  addon.cancelPlan(plan);
  addon.cancelPlan(plan);
  assert.equal(await running, ABORTED);
  assert.equal(lateSettle(FOUND, material), false);
  assert.equal(lateSettle(MISSING), false);
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib duplicate.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const material = new TextEncoder().encode('newmtl material\nKd 1 0 0\n');
  const plan = addon.preparePlan('duplicate.obj', [{ name: 'duplicate.obj', bytes }], options());
  let lateSettle;
  assert.equal(
    await run(plan, (_name, settle) => {
      lateSettle = settle;
      assert.throws(() => settle(), /resolver status/);
      assert.throws(() => settle('found'), /resolver status/);
      assert.throws(() => settle(1.5), /resolver status/);
      assert.throws(() => settle(-1), /resolver status/);
      assert.throws(() => settle(9), /resolver status/);
      assert.equal(settle(FOUND, material), true);
      assert.equal(settle(MISSING), false);
    }),
    1,
  );
  assert.equal(lateSettle(ABORTED), false);
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib first.mtl\nmtllib second.mtl\nmtllib third.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const plan = addon.preparePlan('empty-sidecars.obj', [{ name: 'empty-sidecars.obj', bytes }], options());
  let request = 0;
  assert.equal(
    await run(plan, (_name, settle) => {
      if (request++ === 0) settle(FOUND);
      else if (request === 2) settle(FOUND, undefined);
      else settle(FOUND, null);
    }),
    1,
  );
  assert.equal(request, 3);
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib thrown.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const failed = addon.preparePlan('thrown.obj', [{ name: 'thrown.obj', bytes }], options());
  assert.equal(
    await run(failed, () => {
      throw new Error('resolver failed');
    }),
    FAILED,
  );
  assert.equal(addon.takePlanResult(failed).code, 'RESOLVE_FAILED');
  addon.destroyPlan(failed);

  const settled = addon.preparePlan('thrown.obj', [{ name: 'thrown.obj', bytes }], options());
  assert.equal(
    await run(settled, (_name, settle) => {
      settle(MISSING);
      throw new Error('late resolver failure');
    }),
    1,
  );
  addon.destroyPlan(settled);
}

if (addon._coverageStats) {
  const points = 1_048_576;
  const positions = new Float32Array(points * 3);
  for (let index = 0; index < points; index += 1) {
    positions[index * 3] = index % 1024;
    positions[index * 3 + 1] = Math.floor(index / 1024);
  }
  const sidecarBytes = new Uint8Array(positions.buffer);
  assert.equal(sidecarBytes.byteLength, 12 * 1024 * 1024);
  const source = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'points.bin', byteLength: sidecarBytes.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: sidecarBytes.byteLength }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: points,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1023, 1023, 0],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  const outputPointCount = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(16, true), 0x4e4f534a);
    const jsonLength = view.getUint32(12, true);
    const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    return document.meshes.reduce(
      (total, mesh) =>
        total +
        mesh.primitives.reduce(
          (sum, primitive) => sum + document.accessors[primitive.attributes.POSITION].count,
          0,
        ),
      0,
    );
  };
  let expectedOutput;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const plan = addon.preparePlan('points.gltf', [{ name: 'points.gltf', bytes: source }], options());
    let calls = 0;
    assert.equal(
      await run(plan, (name, settle) => {
        assert.equal(name, 'points.bin');
        calls += 1;
        queueMicrotask(() => settle(FOUND, sidecarBytes));
      }),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(addon._coverageStats(plan).importAttempts, 1);
    const result = addon.takePlanResult(plan);
    assert(result.ok);
    assert.equal(result.formats[0].format, 'glb');
    assert.equal(result.formats[0].files[0].name, 'result.glb');
    const output = Buffer.from(result.formats[0].files[0].bytes);
    assert.equal(outputPointCount(output), points);
    expectedOutput ??= output;
    assert.deepEqual(output, expectedOutput, 'repeated large-sidecar output differs');
    addon.destroyPlan(plan);
    await waitFor(noStagingResources, 'large-sidecar success retained native resources');
    assert.deepEqual(resourceCounts(), {
      activeJobs: 0,
      outstandingRequests: 0,
      queuedJobs: 0,
      retainedBytes: 0,
      stagedBytes: 0,
      transientBytes: 0,
    });
  }

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const plan = addon.preparePlan('points.gltf', [{ name: 'points.gltf', bytes: source }], options());
    let settle;
    const running = run(plan, (name, reply) => {
      assert.equal(name, 'points.bin');
      settle = reply;
    });
    await waitFor(() => settle !== undefined, 'large-sidecar resolver was not delivered');
    assert.deepEqual(resourceCounts(), {
      activeJobs: 1,
      outstandingRequests: 1,
      queuedJobs: 0,
      retainedBytes: 0,
      stagedBytes: source.byteLength,
      transientBytes: 0,
    });
    addon.cancelPlan(plan);
    assert.equal(await running, ABORTED);
    assert.equal(settle(FOUND, sidecarBytes), false);
    assert.deepEqual(addon.takePlanResult(plan), {
      ok: false,
      code: '',
      message: '',
      formats: [],
    });
    addon.destroyPlan(plan);
    await waitFor(noStagingResources, 'large-sidecar cancellation retained native resources');
    assert.deepEqual(resourceCounts(), {
      activeJobs: 0,
      outstandingRequests: 0,
      queuedJobs: 0,
      retainedBytes: 0,
      stagedBytes: 0,
      transientBytes: 0,
    });
  }
}

if (addon._coverageBlockNextExecute) {
  const box = await input('OBJ/box.obj');
  const bytes = Uint8Array.from(box.bytes);
  const plans = Array.from({ length: 4 }, () =>
    addon.preparePlan(box.entry, [{ name: box.entry, bytes }], options()),
  );
  assert.deepEqual(
    { retainedBytes: addon._coverageStats().retainedBytes, stagedBytes: addon._coverageStats().stagedBytes },
    { retainedBytes: bytes.byteLength * plans.length, stagedBytes: 0 },
    'preparePlan copied queued input bytes into native memory',
  );
  addon._coverageBlockNextExecute();
  const activeRun = run(plans[0]);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its gate');
  const queuedRuns = plans.slice(1).map((plan) => run(plan));
  await waitFor(
    () => addon._coverageStats().activeJobs === 1 && addon._coverageStats().queuedJobs === queuedRuns.length,
    'executor did not report queued and active jobs',
  );
  assert.deepEqual(
    {
      retainedBytes: addon._coverageStats().retainedBytes,
      stagedBytes: addon._coverageStats().stagedBytes,
    },
    { retainedBytes: bytes.byteLength * queuedRuns.length, stagedBytes: bytes.byteLength },
    'queued plans staged before FIFO admission',
  );
  bytes.fill(0);
  for (const plan of plans.slice(1)) addon.cancelPlan(plan);
  assert.deepEqual(await Promise.all(queuedRuns), Array(queuedRuns.length).fill(ABORTED));
  assert.deepEqual(addon.takePlanResult(plans[1]).formats, []);
  assert.deepEqual(
    { retainedBytes: addon._coverageStats().retainedBytes, stagedBytes: addon._coverageStats().stagedBytes },
    { retainedBytes: 0, stagedBytes: bytes.byteLength },
    'cancellation before admission copied or retained queued bytes',
  );
  addon._coverageReleaseExecute();
  assert.equal(await activeRun, 1);
  const activeResult = addon.takePlanResult(plans[0]);
  assert(activeResult.ok, 'admitted input was not copied before caller mutation');
  const activeOutput = activeResult.formats[0].files[0].bytes;
  for (const plan of plans) addon.destroyPlan(plan);
  await waitFor(noStagingResources, 'same-environment staging resources survived disposal');

  const expectedPlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  assert.equal(await run(expectedPlan), 1);
  assert.deepEqual(
    activeOutput,
    addon.takePlanResult(expectedPlan).formats[0].files[0].bytes,
    'deferred staging changed conversion output',
  );
  addon.destroyPlan(expectedPlan);
  await waitFor(noStagingResources, 'comparison conversion retained staged input bytes');

  const detached = Uint8Array.from(box.bytes);
  const detachedPlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: detached }], options());
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.equal(await run(detachedPlan), FAILED);
  assert.equal(addon.takePlanResult(detachedPlan).code, 'INVALID_INPUT');
  addon.destroyPlan(detachedPlan);
  await waitFor(noStagingResources, 'detached staging failure retained resources');

  const idlePlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  assert.equal(addon._coverageStats().retainedBytes, box.bytes.byteLength);
  addon.destroyPlan(idlePlan);
  assert.equal(addon._coverageStats().retainedBytes, 0, 'destroy-before-run retained its input reference');

  const emptyPlan = addon.preparePlan(
    'empty.obj',
    [{ name: 'empty.obj', bytes: new Uint8Array() }],
    options(),
  );
  assert.equal(await run(emptyPlan), FAILED);
  addon.destroyPlan(emptyPlan);
  await waitFor(noStagingResources, 'empty staged input retained resources');

  const workerActive = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageBlockNextExecute();
  const workerActiveRun = run(workerActive);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its worker staging gate');
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const bytes = readFileSync(workerData.model);
     const options = {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     };
     const plans = Array.from({ length: workerData.count }, () =>
       addon.preparePlan('box.obj', [{ name: 'box.obj', bytes }], options)
     );
     const running = plans.map((plan) => addon.runPlan(plan, (_name, settle) => settle(0)));
     parentPort.postMessage({ queued: plans.length, bytes: bytes.byteLength });
     parentPort.once('message', async () => {
       for (const plan of plans) addon.cancelPlan(plan);
       const statuses = await Promise.all(running);
       for (const plan of plans) addon.destroyPlan(plan);
       parentPort.postMessage(statuses);
     });`,
    {
      eval: true,
      workerData: {
        addon: addonPath,
        count: 3,
        model: fileURLToPath(new URL('OBJ/box.obj', models)),
      },
    },
  );
  const workerExit = once(worker, 'exit');
  const [{ queued, bytes: workerBytes }] = await once(worker, 'message');
  await waitFor(() => addon._coverageStats().queuedJobs === queued, 'worker jobs were not queued FIFO');
  assert.deepEqual(
    { retainedBytes: addon._coverageStats().retainedBytes, stagedBytes: addon._coverageStats().stagedBytes },
    { retainedBytes: workerBytes * queued, stagedBytes: box.bytes.byteLength },
    'worker inputs staged before process-wide admission',
  );
  worker.postMessage('cancel');
  assert.deepEqual((await once(worker, 'message'))[0], Array(queued).fill(ABORTED));
  assert.equal((await workerExit)[0], 0);
  assert.deepEqual(
    { retainedBytes: addon._coverageStats().retainedBytes, stagedBytes: addon._coverageStats().stagedBytes },
    { retainedBytes: 0, stagedBytes: box.bytes.byteLength },
  );
  addon._coverageReleaseExecute();
  assert.equal(await workerActiveRun, 1);
  addon.destroyPlan(workerActive);
  await waitFor(noStagingResources, 'cross-worker staging resources survived disposal');
}

if (addon._coverageRollbackPlan) {
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageBlockNextExecute();
  const running = run(plan);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its rollback gate');
  addon._coverageRollbackPlan(plan);
  assert.throws(() => run(plan), /already running/);
  addon.cancelPlan(plan);
  assert.equal(await running, ABORTED);
  addon._coverageReleaseExecute();
  addon.destroyPlan(plan);
}

if (addon._coverageBlockNextResolve) {
  const bytes = new TextEncoder().encode(
    'mtllib delayed.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const aborted = addon.preparePlan('delayed.obj', [{ name: 'delayed.obj', bytes }], options());
  addon._coverageBlockNextResolve();
  const abortedRun = run(aborted);
  await waitFor(() => addon._coverageResolveBlocked(), 'resolver did not reach its cancellation gate');
  addon.cancelPlan(aborted);
  assert.equal(await abortedRun, ABORTED);
  addon.destroyPlan(aborted);

  const released = addon.preparePlan('delayed.obj', [{ name: 'delayed.obj', bytes }], options());
  addon._coverageBlockNextResolve();
  const releasedRun = run(released);
  await waitFor(() => addon._coverageResolveBlocked(), 'resolver did not reach its release gate');
  addon._coverageReleaseResolve();
  assert.equal(await releasedRun, 1);
  addon.destroyPlan(released);
}

if (addon._coverageCloseNextDispatch) {
  const bytes = new TextEncoder().encode(
    'mtllib closed.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const resolveClosed = addon.preparePlan('closed.obj', [{ name: 'closed.obj', bytes }], options());
  addon._coverageCloseNextDispatch();
  void run(resolveClosed);
  await waitFor(executorIdle, 'closed resolver dispatch stayed active');
  assert.equal(addon.takePlanResult(resolveClosed).code, 'RESOLVE_FAILED');
  addon.destroyPlan(resolveClosed);

  const box = await input('OBJ/box.obj');
  const completeClosed = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageCloseNextDispatch();
  void run(completeClosed);
  await waitFor(executorIdle, 'closed completion dispatch stayed active');
  assert(addon.takePlanResult(completeClosed).ok);
  addon.destroyPlan(completeClosed);

  const explicitlyClosed = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageBlockNextExecute();
  void run(explicitlyClosed);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its close gate');
  addon._coverageClosePlan(explicitlyClosed);
  addon._coverageReleaseExecute();
  await waitFor(executorIdle, 'explicitly closed plan stayed active');
  addon.destroyPlan(explicitlyClosed);

  const stageClosed = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageCloseNextStageDispatch();
  void run(stageClosed);
  await waitFor(executorIdle, 'closed staging dispatch stayed active');
  assert.equal(addon._coverageStats().retainedBytes, box.bytes.byteLength);
  addon.destroyPlan(stageClosed);
  await waitFor(noStagingResources, 'closed staging dispatch retained resources');
}

if (addon._coverageFailNext) {
  const box = await input('OBJ/box.obj');
  for (const [failure, message] of [
    [1, /could not create runPlan promise/],
    [2, /could not create runPlan thread-safe function/],
    [3, /coverage submit failure/],
    [5, /could not submit native conversion/],
  ]) {
    const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
    addon._coverageFailNext(failure);
    assert.throws(() => run(plan), message);
    assert.equal(await run(plan), failure < 3 ? 1 : ABORTED, 'failed setup retained plan admission');
    addon.destroyPlan(plan);
  }

  for (const [failure, message] of [
    [6, /could not retain native conversion inputs/],
    [11, /could not create native conversion handle/],
  ]) {
    addon._coverageFailNext(failure);
    assert.throws(
      () => addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options()),
      message,
    );
    assert.equal(addon._coverageStats().retainedBytes, 0);
  }

  for (const failure of [7, 8, 9, 10]) {
    const failedStage = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
    addon._coverageFailNext(failure);
    assert.equal(await run(failedStage), FAILED);
    assert.equal(addon.takePlanResult(failedStage).code, 'INVALID_INPUT');
    assert.equal(addon._coverageStats(failedStage).importAttempts, 0);
    if (failure === 7) assert.equal(await run(failedStage), FAILED);
    addon.destroyPlan(failedStage);
    await waitFor(noStagingResources, `staging failure ${failure} retained resources`);
  }

  const cancelledStage = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageFailNext(12);
  assert.equal(await run(cancelledStage), ABORTED);
  addon.destroyPlan(cancelledStage);
  await waitFor(noStagingResources, 'staging cancellation race retained resources');

  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageFailNext(4);
  void run(plan);
  await waitFor(executorIdle, 'failed completion stayed active');
  await waitFor(() => {
    try {
      return addon.takePlanResult(plan).ok;
    } catch {
      return false;
    }
  }, 'failed completion retained plan admission');
  addon._coverageDrainCallbacks(plan);
  assert.equal(await run(plan), 1, 'drained completion retained plan admission');
  addon.destroyPlan(plan);
  addon._coverageCleanupGuard();
}

if (addon._coverageBlockNextProgress) {
  const box = await input('OBJ/box.obj');
  for (const [phase, name] of [
    [IMPORTING, 'importing'],
    [POSTPROCESSING, 'postprocessing'],
    [EXPORTING, 'exporting'],
  ]) {
    const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], {
      ...options(),
      postProcess: TRIANGULATE,
    });
    addon._coverageBlockNextProgress(phase);
    const running = run(plan);
    try {
      await waitFor(
        () => addon._coverageProgressBlocked() === phase,
        `Assimp did not reach its ${name} checkpoint`,
      );
      addon.cancelPlan(plan);
      assert.equal(await running, ABORTED);
      assert.equal(addon._coverageStats(plan).importAttempts, 1);
      assert.deepEqual(addon.takePlanResult(plan).formats, []);
    } finally {
      addon.cancelPlan(plan);
      addon._coverageReleaseProgress();
    }
    await waitFor(noResources, `${name} cancellation retained native resources`);
    assert.deepEqual(resourceCounts(), {
      activeJobs: 0,
      outstandingRequests: 0,
      queuedJobs: 0,
      retainedBytes: 0,
      stagedBytes: box.bytes.byteLength,
      transientBytes: 0,
    });
    addon.destroyPlan(plan);
    await waitFor(noStagingResources, `${name} disposal retained staged input bytes`);
  }
}

if (addon._coverageStopExecutor) {
  const box = await input('OBJ/box.obj');
  const activePlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  const queuedPlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageBlockNextExecute();
  void run(activePlan);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its shutdown gate');
  void run(queuedPlan);
  await waitFor(() => addon._coverageStats().queuedJobs === 1, 'shutdown job was not queued');
  addon._coverageStopExecutor();
  addon._coverageStopExecutor();
  assert.deepEqual(
    { activeJobs: addon._coverageStats().activeJobs, queuedJobs: addon._coverageStats().queuedJobs },
    { activeJobs: 0, queuedJobs: 0 },
  );
  addon.destroyPlan(activePlan);
  addon.destroyPlan(queuedPlan);

  const restarted = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  assert.equal(await run(restarted), 1);
  addon.destroyPlan(restarted);
}

if (addon._coverageBlockNextJoin) {
  const box = await input('OBJ/box.obj');
  const warm = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  assert.equal(await run(warm), 1);
  addon.destroyPlan(warm);

  addon._coverageBlockNextJoin();
  const stopMessages = [];
  const stopWorker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     addon._coverageStopExecutor();
     parentPort.postMessage('stopped');`,
    { eval: true, workerData: { addon: addonPath } },
  );
  stopWorker.on('message', (message) => stopMessages.push(message));
  const stopExit = once(stopWorker, 'exit');
  await waitFor(() => addon._coverageJoinBlocked(), 'executor did not reach its post-join gate');

  const submitMessages = [];
  const submitWorker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.model) }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });
     const running = addon.runPlan(plan, (_name, settle) => settle(0));
     parentPort.postMessage('submitted');
     running.then((status) => {
       const result = addon.takePlanResult(plan);
       addon.destroyPlan(plan);
       parentPort.postMessage({ status, ok: result.ok });
     });`,
    {
      eval: true,
      workerData: {
        addon: addonPath,
        model: fileURLToPath(new URL('OBJ/box.obj', models)),
      },
    },
  );
  submitWorker.on('message', (message) => submitMessages.push(message));
  const submitExit = once(submitWorker, 'exit');
  let admissionError;
  try {
    await waitFor(
      () => submitMessages[0] === 'submitted',
      'requiring and submitting from a new environment blocked on the old worker join',
    );
    assert(addon._coverageJoinBlocked());
    assert.deepEqual(
      { activeJobs: addon._coverageStats().activeJobs, queuedJobs: addon._coverageStats().queuedJobs },
      { activeJobs: 0, queuedJobs: 1 },
    );
  } catch (error) {
    admissionError = error;
  } finally {
    addon._coverageReleaseJoin();
  }
  const [[stopCode], [submitCode]] = await Promise.all([stopExit, submitExit]);
  if (admissionError) throw admissionError;
  assert.equal(stopCode, 0);
  assert.equal(submitCode, 0);
  assert.deepEqual(stopMessages, ['stopped']);
  assert.deepEqual(submitMessages, ['submitted', { status: 1, ok: true }]);
}

if (addon._coverageCloseEnvironment) {
  await runChild(`
    const assert = require('node:assert/strict');
    const { once } = require('node:events');
    const { Worker } = require('node:worker_threads');
    const addonPath = ${JSON.stringify(addonPath)};
    const model = ${JSON.stringify(fileURLToPath(new URL('OBJ/box.obj', models)))};
    const addon = require(addonPath);
    const waitFor = async (predicate, message) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.fail(message);
    };
    const messages = (worker) => {
      const values = [];
      worker.on('message', (value) => values.push(value));
      return values;
    };
    const workerSource = (body) => \`
      const { parentPort, workerData } = require('node:worker_threads');
      const addon = require(workerData.addon);
      \${body}
    \`;
    (async () => {
      addon._coverageCloseEnvironment();
      const first = new Worker(workerSource(\`
      const { readFileSync } = require('node:fs');
      const plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.model) }], {
        importProperties: [], postProcess: 0,
        targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
      });
      addon.runPlan(plan, (_name, settle) => settle(0)).then(() => {
        addon.destroyPlan(plan);
        addon._coverageBlockNextJoin();
        parentPort.postMessage('joining');
        addon._coverageCloseEnvironment();
        parentPort.postMessage('joined');
      });
      \`), { eval: true, workerData: { addon: addonPath, model } });
      const firstMessages = messages(first);
      const firstExit = once(first, 'exit');
      let second;
      let secondExit;
      let third;
      let thirdExit;
      try {
      await waitFor(() => firstMessages.includes('joining'), 'first environment did not begin closing');
      await waitFor(() => addon._coverageJoinBlocked(), 'first environment did not reach the join gate');
        second = new Worker(workerSource(\`
        parentPort.postMessage('opened');
        parentPort.once('message', () => {
          addon._coverageCloseEnvironment();
          parentPort.postMessage('closed');
        });
        \`), { eval: true, workerData: { addon: addonPath } });
        const secondMessages = messages(second);
        secondExit = once(second, 'exit');
      await waitFor(() => secondMessages.includes('opened'), 'second environment did not open');
      second.postMessage('close');
      await waitFor(
        () => addon._coverageStats().joinWaiters === 1,
        'second environment did not wait behind the first join',
      );
      addon._coverageBlockNextExecute();
        third = new Worker(workerSource(\`
        const { readFileSync } = require('node:fs');
        const plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.model) }], {
          importProperties: [], postProcess: 0,
          targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
        });
        const running = addon.runPlan(plan, (_name, settle) => settle(0));
        parentPort.postMessage('submitted');
        running.then((status) => {
          const result = addon.takePlanResult(plan);
          addon.destroyPlan(plan);
          parentPort.postMessage({ status, ok: result.ok });
        });
        \`), { eval: true, workerData: { addon: addonPath, model } });
        const thirdMessages = messages(third);
        thirdExit = once(third, 'exit');
      await waitFor(() => thirdMessages.includes('submitted'), 'third environment did not submit');
      assert.equal(addon._coverageStats().queuedJobs, 1);
      addon._coverageReleaseJoin();
      await waitFor(() => secondMessages.includes('closed'), 'second environment did not finish closing');
      await waitFor(
        () => addon._coverageExecuteBlocked(),
        'waiting closer stopped the newer environment job',
      );
      addon._coverageReleaseExecute();
      await waitFor(() => thirdMessages.length === 2, 'third environment job did not complete');
      assert.deepEqual(thirdMessages, ['submitted', { status: 1, ok: true }]);
        assert.deepEqual(firstMessages, ['joining', 'joined']);
        assert.deepEqual(
          (await Promise.all([firstExit, secondExit, thirdExit])).map(([code]) => code),
          [0, 0, 0],
        );
      } finally {
        addon._coverageReleaseJoin();
        addon._coverageReleaseExecute();
        await Promise.all([first, second, third].filter(Boolean).map((worker) => worker.terminate()));
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);
}

if (addon._coverageStats) {
  const box = await input('OBJ/box.obj');
  addon._coverageBlockNextExecute();
  const activePlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  const activeRun = run(activePlan);
  await waitFor(() => addon._coverageExecuteBlocked(), 'executor did not reach its environment gate');
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.model) }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });
     addon.runPlan(plan, (_name, settle) => settle(0));
     parentPort.postMessage('queued');
     setInterval(() => {}, 1_000);`,
    {
      eval: true,
      workerData: {
        addon: addonPath,
        model: fileURLToPath(new URL('OBJ/box.obj', models)),
      },
    },
  );
  assert.deepEqual(await once(worker, 'message'), ['queued']);
  await waitFor(() => addon._coverageStats().queuedJobs === 1, 'worker plan was not queued');
  assert.equal(await worker.terminate(), 1);
  await waitFor(() => addon._coverageStats().queuedJobs === 0, 'worker queue entry survived cleanup');
  addon.cancelPlan(activePlan);
  assert.equal(await activeRun, ABORTED);
  addon._coverageReleaseExecute();
  addon.destroyPlan(activePlan);
}

if (addon._coverageStats) {
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const options = {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     };
     const box = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.box) }], options);
     const sidecar = addon.preparePlan('cube_usemtl.obj', [{
       name: 'cube_usemtl.obj', bytes: readFileSync(workerData.sidecar)
     }], options);
     addon.runPlan(box, () => {});
     addon.runPlan(sidecar, () => {
       queueMicrotask(() => {
         parentPort.postMessage('blocked');
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
       });
     });`,
    {
      eval: true,
      workerData: {
        addon: addonPath,
        box: fileURLToPath(new URL('OBJ/box.obj', models)),
        sidecar: fileURLToPath(new URL('OBJ/cube_usemtl.obj', models)),
      },
    },
  );
  assert.deepEqual(await once(worker, 'message'), ['blocked']);
  await waitFor(
    () => addon._coverageStats().activeJobs === 1 && addon._coverageStats().outstandingRequests === 1,
    'worker did not queue completion and resolution callbacks',
  );
  assert.equal(await worker.terminate(), 1);
  await waitFor(
    () =>
      addon._coverageStats().activeJobs === 0 &&
      addon._coverageStats().outstandingRequests === 0 &&
      addon._coverageStats().retainedBytes === 0 &&
      addon._coverageStats().stagedBytes === 0,
    'terminated callback queue survived cleanup',
  );
}

if (addon._coverageStats) {
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const bytes = readFileSync(workerData.model);
     const plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });
     addon.runPlan(plan, (_name, settle) => settle(0));
     parentPort.postMessage(bytes.byteLength);
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
    {
      eval: true,
      workerData: {
        addon: addonPath,
        model: fileURLToPath(new URL('OBJ/box.obj', models)),
      },
    },
  );
  const [bytes] = await once(worker, 'message');
  await waitFor(
    () => addon._coverageStats().activeJobs === 1 && addon._coverageStats().retainedBytes === bytes,
    'worker staging callback was not pending',
  );
  assert.equal(await worker.terminate(), 1);
  await waitFor(noStagingResources, 'pending worker staging callback survived teardown');
}

{
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const plan = addon.preparePlan('cube_usemtl.obj', [{
       name: 'cube_usemtl.obj', bytes: readFileSync(workerData.model)
     }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });
     addon.runPlan(plan, () => parentPort.postMessage('resolving'));
     setInterval(() => {}, 1_000);`,
    {
      eval: true,
      workerData: {
        addon: addonPath,
        model: fileURLToPath(new URL('OBJ/cube_usemtl.obj', models)),
      },
    },
  );
  assert.deepEqual(await once(worker, 'message'), ['resolving']);
  assert.equal(await worker.terminate(), 1);
  if (addon._coverageStats) {
    await waitFor(
      () =>
        addon._coverageStats().activeJobs === 0 &&
        addon._coverageStats().queuedJobs === 0 &&
        addon._coverageStats().outstandingRequests === 0 &&
        addon._coverageStats().retainedBytes === 0 &&
        addon._coverageStats().stagedBytes === 0 &&
        addon._coverageStats().transientBytes === 0,
      'worker environment cleanup left native work alive',
    );
  }
}

{
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     const bytes = readFileSync(workerData.model);
     globalThis.plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });
     parentPort.postMessage(bytes.byteLength);
     parentPort.once('message', () => {});`,
    {
      eval: true,
      workerData: { addon: addonPath, model: fileURLToPath(new URL('OBJ/box.obj', models)) },
    },
  );
  const exit = once(worker, 'exit');
  const [bytes] = await once(worker, 'message');
  if (addon._coverageStats) {
    assert.equal(addon._coverageStats().retainedBytes, bytes);
    assert.equal(addon._coverageStats().stagedBytes, 0);
  }
  worker.postMessage('close');
  const [code] = await exit;
  assert.equal(code, 0);
  if (addon._coverageStats)
    await waitFor(noStagingResources, 'idle worker teardown retained its input descriptor');
}

if (addon._coverageStats) {
  await runChild(
    `const assert = require('node:assert/strict');
     const { readFileSync } = require('node:fs');
     const addon = require(${JSON.stringify(addonPath)});
     const bytes = readFileSync(${JSON.stringify(fileURLToPath(new URL('OBJ/box.obj', models)))});
     const options = {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     };
     const waitFor = ${waitFor.toString()};
     let plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes }], options);
     assert.equal(addon._coverageStats().retainedBytes, bytes.byteLength);
     plan = undefined;
     (async () => {
       await waitFor(() => {
         global.gc();
         return addon._coverageStats().retainedBytes === 0;
       }, 'idle plan inputs survived garbage collection');
       assert.equal(addon._coverageStats().retainedBytes, 0);
       assert.equal(addon._coverageStats().stagedBytes, 0);
       addon._coverageBlockNextExecute();
       let active = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes }], options);
       let queued = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes }], options);
       const activeRun = addon.runPlan(active, (_name, settle) => settle(0));
       const queuedRun = addon.runPlan(queued, (_name, settle) => settle(0));
       await waitFor(() => addon._coverageExecuteBlocked() && addon._coverageStats().queuedJobs === 1,
         'garbage collection jobs were not admitted and queued');
       active = undefined;
       queued = undefined;
       global.gc();
       addon._coverageReleaseExecute();
       await Promise.all([activeRun, queuedRun]);
       await waitFor(() => {
         global.gc();
         return !Object.values(addon._coverageStats()).some(Boolean);
       }, 'completed plans survived garbage collection');
       const stats = addon._coverageStats();
       for (const name of ['activeJobs', 'outstandingRequests', 'queuedJobs', 'retainedBytes', 'stagedBytes', 'transientBytes'])
         assert.equal(stats[name], 0, name);
     })().catch((error) => { console.error(error); process.exitCode = 1; });`,
    {},
    ['--expose-gc'],
  );
}

await runChild(
  `const assert = require('node:assert/strict');
   const { readFile } = require('node:fs/promises');
   const { basename, dirname, join } = require('node:path');
   const addon = require(${JSON.stringify(addonPath)});
   const model = ${JSON.stringify(fileURLToPath(new URL('OBJ/spider.obj', models)))};
   (async () => {
     const bytes = await readFile(model);
     const plan = addon.preparePlan(basename(model), [{ name: basename(model), bytes }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });
     const status = await addon.runPlan(plan, (name, settle) => {
       readFile(join(dirname(model), basename(name))).then(
         (sidecar) => settle(1, sidecar),
         (error) => settle(error.code === 'ENOENT' ? 0 : 2)
       );
     });
     assert.equal(status, 1);
     addon.destroyPlan(plan);
   })().catch((error) => { console.error(error); process.exitCode = 1; });`,
  { UV_THREADPOOL_SIZE: '1' },
);

if (addon._coverageFailNext) {
  await runChild(
    `const assert = require('node:assert/strict');
     assert.throws(
       () => require(${JSON.stringify(addonPath)}),
       /could not register native cleanup/
     );`,
    { LIBASSIMP_COVERAGE_FAIL_CLEANUP: '1' },
  );
}

await runChild(
  `const { readFileSync } = require('node:fs');
   const addon = require(${JSON.stringify(addonPath)});
   const model = ${JSON.stringify(fileURLToPath(new URL('OBJ/cube_usemtl.obj', models)))};
   const plan = addon.preparePlan('cube_usemtl.obj', [{ name: 'cube_usemtl.obj', bytes: readFileSync(model) }], {
     importProperties: [], postProcess: 0,
     targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
   });
   addon.runPlan(plan, () => {});`,
);

if (addon._coverageStats) {
  assert.deepEqual(resourceCounts(), {
    activeJobs: 0,
    outstandingRequests: 0,
    queuedJobs: 0,
    retainedBytes: 0,
    stagedBytes: 0,
    transientBytes: 0,
  });
}
