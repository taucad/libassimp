// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

const addonPath = process.env.LIBASSIMP_NATIVE_ADDON;
assert(addonPath, 'LIBASSIMP_NATIVE_ADDON is required');
const addon = createRequire(import.meta.url)(addonPath);
const capabilityEvidence = JSON.parse(
  await readFile(new URL('../../scripts/assimp-capability-evidence.json', import.meta.url), 'utf8'),
);
const packageManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const { internalCanonicalExportRoutes } = await import('../../dist/generated/assimp-capabilities.mjs');

assert.equal(addon.napiVersion, 8);
assert.equal(addon.buildIdentity, `${process.platform}-${process.arch}-napi8`);
assert.equal(addon.packageVersion, packageManifest.version);
assert(addon.importFormats.some(({ id }) => id === 'obj'));
assert(addon.exportFormats.some(({ id }) => id === 'glb2'));
assert.deepEqual(
  addon.importFormats.map(({ id }) => id).toSorted(),
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
  addon.exportFormats.map(({ id }) => id).toSorted(),
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
  return { entry: basename(url.pathname), directory: dirname(url.pathname), bytes: await readFile(url) };
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
  source.fill(0);
  assert.equal(await addon.runPlan(plan), 1);
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
  let status;
  for (let attempts = 0; attempts < 32; attempts += 1) {
    status = await addon.runPlan(plan);
    if (status !== -1) break;
    const name = addon.pendingName(plan);
    assert.equal(typeof name, 'string');
    if (attempts === 0)
      assert.throws(() => addon.supplyPlan(plan, 'wrong-name', undefined), /does not match/);
    let bytes;
    try {
      bytes = await readFile(join(spider.directory, basename(name)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    addon.supplyPlan(plan, name, bytes);
  }
  assert.equal(status, 1);
  assert(addon.takePlanResult(plan).ok);
  addon.destroyPlan(plan);
}

if (addon._coverageQueueFailure) {
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  assert.throws(() => addon.supplyPlan(plan, undefined), /does not match/);
  assert.throws(() => addon._coverageQueueFailure(plan), /coverage queue failure/);
  assert.equal(await addon.runPlan(plan), 1);
  addon.destroyPlan(plan);
}

if (addon._coverageExecutionFailure) {
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  await assert.rejects(addon._coverageExecutionFailure(plan), /coverage execution failure/);
  assert.equal(await addon.runPlan(plan), 1);
  addon.destroyPlan(plan);
}

if (addon._coverageBlockNextExecute) {
  assert.equal(process.env.UV_THREADPOOL_SIZE, '2');
  const box = await input('OBJ/box.obj');
  const plans = Array.from({ length: 8 }, () =>
    addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options()),
  );
  addon._coverageBlockNextExecute();
  const runs = [
    addon.runPlan(plans[0]),
    addon._coverageQueueFailure(plans[1]),
    ...plans.slice(2).map((plan) => addon.runPlan(plan)),
  ];
  for (let attempt = 0; attempt < 1_000 && !addon._coverageExecuteBlocked(); attempt += 1) {
    await new Promise(setImmediate);
  }
  assert(addon._coverageExecuteBlocked(), 'coverage worker did not reach its execution gate');
  const fsAvailable = await Promise.race([
    readFile(import.meta.filename).then(() => true),
    new Promise((resolve) => setTimeout(resolve, 500, false)),
  ]);
  addon._coverageReleaseExecute();
  assert.equal(fsAvailable, true, 'queued conversions saturated the shared libuv pool');
  await assert.rejects(runs[1], /coverage queue failure/);
  assert.deepEqual(await Promise.all([runs[0], ...runs.slice(2)]), Array(7).fill(1));
  assert.equal(await addon.runPlan(plans[1]), 1);
  for (const plan of plans) addon.destroyPlan(plan);

  const startBlockedWorker = async () => {
    addon._coverageBlockNextExecute();
    const mainPlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
    const mainRun = addon.runPlan(mainPlan);
    for (let attempt = 0; attempt < 1_000 && !addon._coverageExecuteBlocked(); attempt += 1) {
      await new Promise(setImmediate);
    }
    const gate = new SharedArrayBuffer(4);
    const worker = new Worker(
      `const { readFileSync } = require('node:fs');
       const { parentPort, workerData } = require('node:worker_threads');
       const addon = require(workerData.addon);
       const plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.model) }], {
         importProperties: [], postProcess: 0,
         targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
       });
       addon.runPlan(plan);
       parentPort.postMessage('queued');
       Atomics.wait(new Int32Array(workerData.gate), 0, 0);`,
      {
        eval: true,
        workerData: { addon: addonPath, gate, model: new URL('OBJ/box.obj', models).pathname },
      },
    );
    assert.deepEqual(await once(worker, 'message'), ['queued']);
    return { mainPlan, mainRun, worker };
  };

  {
    const { mainPlan, mainRun, worker } = await startBlockedWorker();
    assert.equal(await worker.terminate(), 1);
    addon._coverageReleaseExecute();
    assert.equal(await mainRun, 1);
    addon.destroyPlan(mainPlan);
  }

  {
    const { mainPlan, mainRun, worker } = await startBlockedWorker();
    addon._coverageReleaseExecute();
    assert.equal(await mainRun, 1);
    assert.equal(await worker.terminate(), 1);
    addon.destroyPlan(mainPlan);
  }

  const cleanupPlan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  addon._coverageDispatchCleanup(cleanupPlan);
  assert.equal(await addon.runPlan(cleanupPlan), 1);
  addon.destroyPlan(cleanupPlan);
}

{
  const box = await input('OBJ/box.obj');
  const plans = [
    addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options()),
    addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options()),
  ];
  assert.deepEqual(await Promise.all(plans.map((plan) => addon.runPlan(plan))), [1, 1]);
  for (const plan of plans) addon.destroyPlan(plan);
}

{
  const box = await input('OBJ/box.obj');
  const plan = addon.preparePlan(box.entry, [{ name: box.entry, bytes: box.bytes }], options());
  const running = addon.runPlan(plan);
  assert.throws(() => addon.runPlan(plan), /already running/);
  assert.throws(() => addon.pendingName(plan), /already running/);
  addon.destroyPlan(plan);
  addon.destroyPlan(plan);
  assert.equal(await running, 1);
}

assert.throws(() => addon.preparePlan('', [], {}), /postProcess/);
assert.throws(() => addon.preparePlan(), /expects entryName/);
assert.throws(() => addon.runPlan(), /expects a plan/);
assert.throws(() => addon.pendingName(), /expects a plan/);
assert.throws(() => addon.pendingName({}), /opaque conversion plan/);
if (addon._coverageWrongPlan)
  assert.throws(() => addon.pendingName(addon._coverageWrongPlan()), /opaque conversion plan/);
assert.throws(() => addon.supplyPlan(), /expects plan/);
assert.throws(() => addon.takePlanResult(), /expects a plan/);
assert.throws(() => addon.destroyPlan(), /expects a plan/);
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
  assert.equal(addon.pendingName(plan), undefined);
  assert.equal(await addon.runPlan(plan), 2);
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
  let status;
  for (let attempts = 0; attempts < 8; attempts += 1) {
    status = await addon.runPlan(plan);
    if (status !== -1) break;
    addon.supplyPlan(plan, attempts === 0 ? null : undefined);
  }
  assert.equal(status, 1);
  addon.destroyPlan(plan);
}

{
  const bytes = new TextEncoder().encode(
    'mtllib missing.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const plan = addon.preparePlan('missing.obj', [{ name: 'missing.obj', bytes }], options());
  let status;
  for (let attempts = 0; attempts < 8; attempts += 1) {
    status = await addon.runPlan(plan);
    if (status !== -1) break;
    if (attempts === 0) assert.equal(addon.pendingName(plan), 'missing.mtl');
    addon.supplyPlan(plan, undefined);
  }
  assert.equal(status, 1);
  addon.destroyPlan(plan);
}

{
  const worker = new Worker(
    `const { readFileSync } = require('node:fs');
     const { workerData } = require('node:worker_threads');
     const addon = require(workerData.addon);
     globalThis.plan = addon.preparePlan('box.obj', [{ name: 'box.obj', bytes: readFileSync(workerData.model) }], {
       importProperties: [], postProcess: 0,
       targets: [{ format: 'glb', nativeId: 'glb2', properties: [] }]
     });`,
    {
      eval: true,
      workerData: { addon: addonPath, model: new URL('OBJ/box.obj', models).pathname },
    },
  );
  const [code] = await once(worker, 'exit');
  assert.equal(code, 0);
}
