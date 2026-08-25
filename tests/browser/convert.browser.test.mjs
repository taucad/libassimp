import { beforeAll, expect, test } from 'vitest';

import { AssimpError, createAssimp } from 'libassimp-candidate';
import { convert as convertToGltf } from 'libassimp-candidate/importer';
import { convert as convertFromGltf } from 'libassimp-candidate/exporter';

const bytesAt = async (url) => {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
};

const withAssimp = async (operation) => {
  const assimp = await createAssimp();
  try {
    return await operation(assimp);
  } finally {
    assimp.dispose();
  }
};

const filesSnapshot = (results) =>
  results.map(({ format, files }) => ({
    format,
    files: files.map(({ name, bytes }) => ({ name, bytes })),
  }));

const errorSnapshot = async (operation) => {
  let thrown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error('Expected conversion to fail.');
  expect(thrown).toBeInstanceOf(AssimpError);
  return {
    code: thrown.code,
    message: thrown.message,
    format: thrown.format,
    formatIndex: thrown.formatIndex,
    fileName: thrown.fileName,
    cause:
      thrown.cause instanceof Error
        ? { name: thrown.cause.name, message: thrown.cause.message }
        : thrown.cause,
  };
};

const withoutJspi = async (operation) => {
  const suspending = Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending');
  const promising = Object.getOwnPropertyDescriptor(WebAssembly, 'promising');
  Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
  Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
  try {
    expect(WebAssembly.Suspending).toBeUndefined();
    expect(WebAssembly.promising).toBeUndefined();
    return await operation();
  } finally {
    if (suspending === undefined) delete WebAssembly.Suspending;
    else Object.defineProperty(WebAssembly, 'Suspending', suspending);
    if (promising === undefined) delete WebAssembly.promising;
    else Object.defineProperty(WebAssembly, 'promising', promising);
  }
};

let cube;
let materialCube;
let material;
let externalGltf;
let points;

beforeAll(async () => {
  [cube, materialCube, material, externalGltf, points] = await Promise.all([
    bytesAt(new URL('../fixtures/cube.obj', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/OBJ/cube_usemtl.obj', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/OBJ/cube_usemtl.mtl', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/glTF2/BoxTextured-glTF/BoxTextured.gltf', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/PLY/points.ply', import.meta.url)),
  ]);
});

test('loads default entry artifacts and round-trips geometry in the browser', async () => {
  const { files: gltf } = await convertToGltf({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
  expect(gltf.map(({ name }) => name)).toEqual(['result.glb']);
  expect(new TextDecoder().decode(gltf[0].bytes.subarray(0, 4))).toBe('glTF');

  const { files: stl } = await convertFromGltf({ name: 'model.glb', bytes: gltf[0].bytes }, { to: 'stl' });
  const { files: roundTrip } = await convertToGltf({ name: stl[0].name, bytes: stl[0].bytes }, { to: 'glb' });
  expect(new TextDecoder().decode(roundTrip[0].bytes.subarray(0, 4))).toBe('glTF');
});

test('resolves a sidecar asynchronously and returns an exact ordered plural result', async () => {
  const asked = [];
  const results = await withAssimp((assimp) =>
    assimp.convertFormats(
      { name: 'cube_usemtl.obj', bytes: materialCube },
      {
        resolve: async (name) => {
          asked.push(name);
          await Promise.resolve();
          return name === 'cube_usemtl.mtl' ? material : undefined;
        },
        targets: [{ to: 'glb' }, { to: 'stl', exportOptions: { binary: true } }, { to: 'glb' }],
      },
    ),
  );
  expect(asked).toEqual(['cube_usemtl.mtl']);
  expect(results.map(({ format }) => format)).toEqual(['glb', 'stl', 'glb']);
  expect(results[0].files).toEqual(results[2].files);
  expect(results[1].files[0].bytes.byteLength).toBe(684);
});

const isChromium = navigator.userAgent.includes('Chrome');
test.skipIf(!isChromium)('uses JSPI and forced replay with exact same-artifact behavior', async () => {
  expect(typeof WebAssembly.Suspending).toBe('function');
  expect(typeof WebAssembly.promising).toBe('function');

  const successful = async () => {
    const asked = [];
    const results = await withAssimp((assimp) =>
      assimp.convertFormats(
        { name: 'cube_usemtl.obj', bytes: materialCube },
        {
          resolve: async (name) => {
            asked.push(name);
            await Promise.resolve();
            return name === 'cube_usemtl.mtl' ? material : undefined;
          },
          targets: [{ to: 'glb' }, { to: 'gltf' }, { to: 'stl', exportOptions: { binary: true } }],
        },
      ),
    );
    return { asked, results: filesSnapshot(results) };
  };

  const rejected = () =>
    errorSnapshot(() =>
      withAssimp((assimp) =>
        assimp.convert(
          { name: 'cube_usemtl.obj', bytes: materialCube },
          {
            to: 'glb',
            resolve: async () => {
              await Promise.resolve();
              throw new Error('network unavailable');
            },
          },
        ),
      ),
    );
  const missing = () =>
    errorSnapshot(() =>
      withAssimp((assimp) =>
        assimp.convert(
          { name: 'BoxTextured.gltf', bytes: externalGltf },
          { to: 'glb', resolve: async () => undefined },
        ),
      ),
    );
  const importFailed = () =>
    errorSnapshot(() =>
      withAssimp((assimp) =>
        assimp.convert({ name: 'broken.obj', bytes: new Uint8Array([1, 2, 3]) }, { to: 'glb' }),
      ),
    );
  const exportFailed = () =>
    errorSnapshot(() =>
      withAssimp((assimp) => assimp.convert({ name: 'points.ply', bytes: points }, { to: '3mf' })),
    );

  const normal = {
    successful: await successful(),
    rejected: await rejected(),
    missing: await missing(),
    importFailed: await importFailed(),
    exportFailed: await exportFailed(),
  };
  const replay = await withoutJspi(async () => ({
    successful: await successful(),
    rejected: await rejected(),
    missing: await missing(),
    importFailed: await importFailed(),
    exportFailed: await exportFailed(),
  }));

  expect(replay).toEqual(normal);
  expect(normal.successful.asked).toEqual(['cube_usemtl.mtl']);
  expect(normal.rejected).toMatchObject({ code: 'RESOLVE_FAILED', fileName: 'cube_usemtl.mtl' });
  expect(normal.missing.code).toBe('IMPORT_FAILED');
  expect(normal.importFailed.code).toBe('IMPORT_FAILED');
  expect(normal.exportFailed).toMatchObject({ code: 'EXPORT_FAILED', format: '3mf', formatIndex: 0 });
});
