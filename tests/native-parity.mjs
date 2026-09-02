#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const cjsBinding = createRequire(import.meta.url)('../dist/native/index.cjs');
assert.equal(cjsBinding.buildIdentity, `${process.platform}-${process.arch}-napi8`);
assert.equal(cjsBinding.napiVersion, 8);
assert.equal(cjsBinding.packageVersion, packageManifest.version);
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
