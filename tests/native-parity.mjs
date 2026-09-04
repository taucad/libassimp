#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readScalePointCount, writeScaleFixture } from './generate-scale-fixture.mjs';

const glbPointCount = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(16, true), 0x4e4f534a);
  const jsonLength = view.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  return document.meshes.reduce(
    (total, mesh) =>
      total +
      mesh.primitives.reduce((sum, primitive) => {
        assert.equal(primitive.mode, 0);
        return sum + document.accessors[primitive.attributes.POSITION].count;
      }, 0),
    0,
  );
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const native = await import('../dist/index.node.mjs');
const wasm = await import('../dist/index.mjs');
const bytes = new Uint8Array(readFileSync(new URL('./fixtures/cube.obj', import.meta.url)));
const request = [{ name: 'cube.obj', bytes }, { to: 'glb' }];
const nativeAssimp = await native.createAssimp({ backend: 'native' });
const wasmAssimp = await wasm.createAssimp({ backend: 'wasm' });
assert.equal(nativeAssimp.backend, 'native');
const [nativeResult, wasmResult] = await Promise.all([
  nativeAssimp.convert(...request),
  wasmAssimp.convert(...request),
]);
const comparable = ({ files }) =>
  files.map(({ name, bytes: output }) => ({ name, bytes: Buffer.from(output) }));
assert.deepEqual(comparable(nativeResult), comparable(wasmResult), 'native/Wasm bytes differ');
for (const backend of [nativeAssimp, wasmAssimp]) {
  await assert.rejects(backend.convert({ name: 'bad.obj', bytes: new Uint8Array([0]) }, { to: 'glb' }));
}
const instance = await native.createAssimp({ backend: 'native' });
instance.dispose();
await assert.rejects(instance.convert(...request), /disposed/iu);

// A required external buffer exercises large sidecar ownership, not just a
// material file whose absence an importer can silently tolerate.
{
  const directory = mkdtempSync(join(tmpdir(), 'libassimp-large-sidecar-'));
  const points = 1_048_576;
  const positions = new Float32Array(points * 3);
  for (let index = 0; index < points; index += 1) {
    positions[index * 3] = index % 1024;
    positions[index * 3 + 1] = Math.floor(index / 1024);
  }
  const sidecarBytes = new Uint8Array(positions.buffer);
  const input = {
    name: 'points.gltf',
    bytes: new TextEncoder().encode(
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
    ),
  };
  try {
    const path = join(directory, 'points.bin');
    await writeFile(path, sidecarBytes);
    let expectedDigest;
    for (const backend of [nativeAssimp, wasmAssimp]) {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        let calls = 0;
        const result = await backend.convert(input, {
          to: 'glb',
          resolve: async (name) => {
            assert.equal(name, 'points.bin');
            calls += 1;
            return new Uint8Array(await readFile(path));
          },
        });
        assert.equal(calls, 1);
        assert.equal(glbPointCount(result.files[0].bytes), points);
        const digest = sha256(result.files[0].bytes);
        expectedDigest ??= digest;
        assert.equal(digest, expectedDigest, 'repeated large-sidecar output differs');

        const controller = new AbortController();
        const reason = new Error('large sidecar cancelled');
        let opened;
        let settle;
        const requested = new Promise((resolve) => {
          opened = resolve;
        });
        const pending = backend.convert(input, {
          to: 'glb',
          signal: controller.signal,
          resolve: () =>
            new Promise((resolve) => {
              settle = resolve;
              opened();
            }),
        });
        await requested;
        controller.abort(reason);
        await assert.rejects(pending, (error) => error === reason);
        settle(sidecarBytes);
      }
    }
    process.stdout.write(
      `large async sidecar: ${sidecarBytes.byteLength} bytes, ${points} exact points, repeated/cancelled native-Wasm parity passed\n`,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (process.env['LIBASSIMP_SCALE'] === '1') {
  const directory = mkdtempSync(join(tmpdir(), 'libassimp-scale-'));
  try {
    const path = join(directory, 'scale.ply');
    writeScaleFixture(path);
    const large = new Uint8Array(readFileSync(path));
    const expectedPoints = readScalePointCount(large);
    let ticked = false;
    const pending = nativeAssimp.convert({ name: 'scale.ply', bytes: large }, { to: 'glb' });
    setImmediate(() => {
      ticked = true;
    });
    let nativeLarge = await pending;
    assert(ticked, 'native conversion blocked the event loop');
    assert.equal(glbPointCount(nativeLarge.files[0].bytes), expectedPoints);
    const nativeDigest = sha256(nativeLarge.files[0].bytes);
    nativeLarge = undefined;
    const wasmLarge = await wasmAssimp.convert({ name: 'scale.ply', bytes: large }, { to: 'glb' });
    assert.equal(glbPointCount(wasmLarge.files[0].bytes), expectedPoints);
    assert.equal(sha256(wasmLarge.files[0].bytes), nativeDigest, 'large native/Wasm bytes differ');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

nativeAssimp.dispose();
wasmAssimp.dispose();

process.stdout.write('native/Wasm parity, malformed input, lifecycle, and event-loop checks passed\n');
