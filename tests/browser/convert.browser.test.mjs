// Both subpath entries, loaded and run in a real browser: each fetches its own
// wasm through the default `wasmUrl`, so a binary a browser cannot instantiate
// fails here rather than in an application.
import { beforeAll, expect, test } from 'vitest';

import { convert as convertToGltf } from 'libassimp-candidate/importer';
import { convert as convertFromGltf } from 'libassimp-candidate/exporter';

let cube;

beforeAll(async () => {
  const response = await fetch(new URL('../fixtures/cube.obj', import.meta.url));
  expect(response.ok).toBe(true);
  cube = new Uint8Array(await response.arrayBuffer());
});

test('libassimp/importer converts obj to glb in the browser', async () => {
  const { files } = await convertToGltf({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
  expect(files[0].name).toBe('result.glb');
  expect(new TextDecoder().decode(files[0].bytes.subarray(0, 4))).toBe('glTF');
});

test('libassimp/exporter converts glb to stl in the browser', async () => {
  const { files: gltf } = await convertToGltf({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
  const { files } = await convertFromGltf({ name: 'model.glb', bytes: gltf[0].bytes }, { to: 'stl' });
  expect(files[0].name).toBe('result.stl');
  expect(files[0].bytes.byteLength).toBeGreaterThan(0);
});
