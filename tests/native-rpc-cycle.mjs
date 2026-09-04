// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { MessageChannel, isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';

const nativeUrl = new URL('../dist/index.node.mjs', import.meta.url).href;
const cubeUrl = new URL('./fixtures/cube.obj', import.meta.url);
const materialUrl = new URL('./fixtures/cube-material.obj', import.meta.url);

const summarize = (result) => {
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'result.glb');
  assert.equal(Buffer.from(result.files[0].bytes.subarray(0, 4)).toString('latin1'), 'glTF');
  return createHash('sha256').update(result.files[0].bytes).digest('hex');
};

if (!isMainThread) {
  const { createAssimp } = await import(nativeUrl);
  const assimp = await createAssimp({ backend: 'native' });
  const fail = (error) => parentPort.postMessage({ type: 'error', error: error?.stack ?? String(error) });

  if (workerData.role === 'outer') {
    const bytes = new Uint8Array(await readFile(materialUrl));
    void assimp
      .convert(
        { name: 'cube-material.obj', bytes },
        {
          to: 'glb',
          resolve: (name) => {
            assert.equal(name, 'cube-material.mtl');
            workerData.port.postMessage('convert');
            parentPort.postMessage({ type: 'resolver-pending' });
            return new Promise((resolve) => workerData.port.once('message', resolve));
          },
        },
      )
      .then(() => parentPort.postMessage({ type: 'unexpected-completion' }), fail);
  } else {
    const bytes = new Uint8Array(await readFile(cubeUrl));
    let settled = false;
    workerData.port.once('message', () => {
      const pending = assimp.convert({ name: 'cube.obj', bytes }, { to: 'glb' });
      parentPort.postMessage({ type: 'queued' });
      void pending.then((result) => {
        settled = true;
        workerData.port.postMessage('resolved');
        parentPort.postMessage({ type: 'drained', digest: summarize(result) });
      }, fail);
    });
    parentPort.on('message', (message) => {
      if (message === 'probe') parentPort.postMessage({ type: 'probe', settled });
      else if (message === 'subsequent') {
        void assimp.convert({ name: 'cube.obj', bytes }, { to: 'glb' }).then((result) => {
          assimp.dispose();
          parentPort.postMessage({ type: 'subsequent', digest: summarize(result) });
          parentPort.close();
          workerData.port.close();
        }, fail);
      }
    });
    parentPort.postMessage({ type: 'ready' });
  }
} else {
  const addonPath = process.env['NAPI_RS_NATIVE_LIBRARY_PATH'];
  const addon = addonPath === undefined ? undefined : createRequire(import.meta.url)(addonPath);
  const stats = typeof addon?._coverageStats === 'function' ? () => addon._coverageStats() : undefined;
  if (process.argv.includes('--require-counters')) {
    assert(stats !== undefined, 'the coverage lane requires native resource counters');
  }
  const deadline = setTimeout(() => assert.fail('cross-worker RPC recovery timed out'), 15_000).unref();
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
  };
  const assertStats = (expected) => {
    const actual = stats();
    assert.deepEqual(actual, Object.fromEntries(Object.keys(actual).map((key) => [key, expected[key]])));
  };

  const { port1, port2 } = new MessageChannel();
  const rpc = new Worker(new URL(import.meta.url), {
    workerData: { port: port2, role: 'rpc' },
    transferList: [port2],
  });
  assert.deepEqual((await once(rpc, 'message'))[0], { type: 'ready' });
  const outer = new Worker(new URL(import.meta.url), {
    workerData: { port: port1, role: 'outer' },
    transferList: [port1],
  });
  const resolverPending = once(outer, 'message');
  const queued = once(rpc, 'message');
  assert.deepEqual((await resolverPending)[0], { type: 'resolver-pending' });
  assert.deepEqual((await queued)[0], { type: 'queued' });

  rpc.postMessage('probe');
  assert.deepEqual((await once(rpc, 'message'))[0], { type: 'probe', settled: false });
  if (stats !== undefined) {
    const retainedBytes = (await readFile(cubeUrl)).byteLength;
    const stagedBytes = (await readFile(materialUrl)).byteLength;
    await waitFor(() => {
      const current = stats();
      return current.activeJobs === 1 && current.queuedJobs === 1 && current.outstandingRequests === 1;
    }, 'cross-worker RPC cycle did not reach the native queue');
    assertStats({
      activeJobs: 1,
      joinWaiters: 0,
      outstandingRequests: 1,
      queuedJobs: 1,
      retainedBytes,
      stagedBytes,
      transientBytes: 0,
    });
  }

  const drained = once(rpc, 'message');
  assert.equal(await outer.terminate(), 1);
  const first = (await drained)[0];
  assert.equal(first.type, 'drained', first.error);
  if (stats !== undefined) {
    await waitFor(
      () => Object.values(stats()).every((count) => count === 0),
      'terminated environment retained work',
    );
    assertStats({
      activeJobs: 0,
      joinWaiters: 0,
      outstandingRequests: 0,
      queuedJobs: 0,
      retainedBytes: 0,
      stagedBytes: 0,
      transientBytes: 0,
    });
  }

  const rpcExit = once(rpc, 'exit');
  rpc.postMessage('subsequent');
  const subsequent = (await once(rpc, 'message'))[0];
  assert.equal(subsequent.type, 'subsequent', subsequent.error);
  assert.equal(subsequent.digest, first.digest);
  assert.deepEqual(await rpcExit, [0]);
  if (stats !== undefined) assertStats(Object.fromEntries(Object.keys(stats()).map((key) => [key, 0])));
  clearTimeout(deadline);
  process.stdout.write(
    `cross-worker RPC cycle terminated and recovered; counters=${stats ? 'exact' : 'unavailable'}\n`,
  );
}
