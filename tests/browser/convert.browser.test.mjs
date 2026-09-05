import { beforeAll, expect, test } from 'vitest';

import { AssimpError, convert, createAssimp } from 'libassimp-candidate';

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

const zipMembers = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x0605_4b50) end -= 1;
  if (end < 0) throw new Error('ZIP end record not found.');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x0201_4b50) {
      throw new Error('Invalid ZIP central directory.');
    }
    const nameLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return names;
};

const leafName = (name) => name.replaceAll('\\', '/').split('/').at(-1);

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
let manifold;
let spider;
let spiderSidecars;

const spiderSidecarFixtures = [
  ['spider.mtl', new URL('../../assimp/test/models/OBJ/spider.mtl', import.meta.url)],
  ['SpiderTex.jpg', new URL('../../assimp/test/models/OBJ/SpiderTex.jpg', import.meta.url)],
  ['drkwood2.jpg', new URL('../../assimp/test/models/OBJ/drkwood2.jpg', import.meta.url)],
  ['engineflare1.jpg', new URL('../../assimp/test/models/OBJ/engineflare1.jpg', import.meta.url)],
  ['wal67ar_small.jpg', new URL('../../assimp/test/models/OBJ/wal67ar_small.jpg', import.meta.url)],
  ['wal69ar_small.jpg', new URL('../../assimp/test/models/OBJ/wal69ar_small.jpg', import.meta.url)],
];

beforeAll(async () => {
  [cube, materialCube, material, externalGltf, points, manifold, spider, spiderSidecars] = await Promise.all([
    bytesAt(new URL('../fixtures/cube.obj', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/OBJ/cube_usemtl.obj', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/OBJ/cube_usemtl.mtl', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/glTF2/BoxTextured-glTF/BoxTextured.gltf', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/PLY/points.ply', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/glTF2/EXT_mesh_manifold/TwoMaterialBox.glb', import.meta.url)),
    bytesAt(new URL('../../assimp/test/models/OBJ/spider.obj', import.meta.url)),
    Promise.all(spiderSidecarFixtures.map(async ([name, url]) => [name, await bytesAt(url)])).then(
      (entries) => new Map(entries),
    ),
  ]);
});

test('loads default entry artifacts and round-trips geometry in the browser', async () => {
  const { files: gltf } = await convert({ name: 'cube.obj', bytes: cube }, { to: 'glb' });
  expect(gltf.map(({ name }) => name)).toEqual(['result.glb']);
  expect(new TextDecoder().decode(gltf[0].bytes.subarray(0, 4))).toBe('glTF');

  const { files: stl } = await convert({ name: 'model.glb', bytes: gltf[0].bytes }, { to: 'stl' });
  const { files: roundTrip } = await convert({ name: stl[0].name, bytes: stl[0].bytes }, { to: 'glb' });
  expect(new TextDecoder().decode(roundTrip[0].bytes.subarray(0, 4))).toBe('glTF');
});

test('exports EXT_mesh_manifold to 3MF and reimports it in the browser', async () => {
  const { files } = await convert({ name: 'TwoMaterialBox.glb', bytes: manifold }, { to: '3mf' });
  expect(new TextDecoder().decode(files[0].bytes.subarray(0, 2))).toBe('PK');
  const { files: roundTrip } = await convert({ name: files[0].name, bytes: files[0].bytes }, { to: 'glb' });
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

test('cancels unresolved sidecars, ignores late settlement, and reuses both Wasm routes', async () => {
  const exercise = () =>
    withAssimp(async (assimp) => {
      const input = { name: 'cube_usemtl.obj', bytes: materialCube };
      const options = { to: 'glb', resolve: () => material };
      const expected = await assimp.convert(input, options);
      for (const lateFailure of [false, true]) {
        const controller = new AbortController();
        const reason = { kind: 'superseded', lateFailure };
        let opened;
        let settle;
        const requested = new Promise((resolve) => {
          opened = resolve;
        });
        const pending = assimp.convert(input, {
          to: 'glb',
          signal: controller.signal,
          resolve: () =>
            new Promise((resolve, reject) => {
              settle = lateFailure ? reject : resolve;
              opened();
            }),
        });
        await requested;
        const queuedController = new AbortController();
        const queuedReason = { kind: 'cancelled-before-admission' };
        const queued = assimp.convert(input, { ...options, signal: queuedController.signal });
        queuedController.abort(queuedReason);
        await expect(queued).rejects.toBe(queuedReason);
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
        settle(lateFailure ? new Error('late provider failure') : material);
        let resolverCalls = 0;
        await expect(
          assimp.convert(input, {
            to: 'glb',
            signal: controller.signal,
            resolve: () => {
              resolverCalls += 1;
              return material;
            },
          }),
        ).rejects.toBe(reason);
        expect(resolverCalls).toBe(0);
        expect(await assimp.convert(input, options)).toEqual(expected);
      }
      return expected;
    });

  const normal = await exercise();
  expect(await withoutJspi(exercise)).toEqual(normal);
});

const isChromium = navigator.userAgent.includes('Chrome');
test.skipIf(!isChromium)('exposes JSPI on the supported Chromium host', () => {
  expect(typeof WebAssembly.Suspending).toBe('function');
  expect(typeof WebAssembly.promising).toBe('function');
});

test('preserves export textures and exact same-artifact resolution across Wasm routes', async () => {
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

  const textured = async () => {
    const asked = [];
    const { files } = await withAssimp((assimp) =>
      assimp.convert(
        { name: 'spider.obj', bytes: spider },
        {
          to: 'usdz',
          resolve: async (requested) => {
            const name = leafName(requested);
            asked.push(name);
            await Promise.resolve();
            return spiderSidecars.get(name);
          },
        },
      ),
    );
    return { asked, bytes: files[0].bytes, members: zipMembers(files[0].bytes) };
  };

  const textureRejected = () =>
    errorSnapshot(() =>
      withAssimp((assimp) =>
        assimp.convert(
          { name: 'spider.obj', bytes: spider },
          {
            to: 'usdz',
            resolve: (requested) => {
              const name = leafName(requested);
              if (name === 'spider.mtl') return spiderSidecars.get(name);
              return Promise.reject(new Error('texture unavailable'));
            },
          },
        ),
      ),
    );

  const textureAborted = () =>
    withAssimp(async (assimp) => {
      const controller = new AbortController();
      const reason = { kind: 'texture-cancelled' };
      let opened;
      let settle;
      const requested = new Promise((resolve) => {
        opened = resolve;
      });
      const pending = assimp.convert(
        { name: 'spider.obj', bytes: spider },
        {
          to: 'usdz',
          signal: controller.signal,
          resolve: (requestedName) => {
            const name = leafName(requestedName);
            if (name === 'spider.mtl') return spiderSidecars.get(name);
            return new Promise((resolve) => {
              settle = resolve;
              opened(name);
            });
          },
        },
      );
      await expect(requested).resolves.toBe('SpiderTex.jpg');
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      settle(spiderSidecars.get('SpiderTex.jpg'));
      const recovered = await assimp.convert(
        { name: 'spider.obj', bytes: spider },
        { to: 'usdz', resolve: (name) => spiderSidecars.get(leafName(name)) },
      );
      return {
        requested: 'SpiderTex.jpg',
        recovered: recovered.files[0].bytes,
        members: zipMembers(recovered.files[0].bytes),
      };
    });

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
    textured: await textured(),
    textureRejected: await textureRejected(),
    textureAborted: await textureAborted(),
    rejected: await rejected(),
    missing: await missing(),
    importFailed: await importFailed(),
    exportFailed: await exportFailed(),
  };
  const replay = await withoutJspi(async () => ({
    successful: await successful(),
    textured: await textured(),
    textureRejected: await textureRejected(),
    textureAborted: await textureAborted(),
    rejected: await rejected(),
    missing: await missing(),
    importFailed: await importFailed(),
    exportFailed: await exportFailed(),
  }));

  expect(replay).toEqual(normal);
  expect(normal.successful.asked).toEqual(['cube_usemtl.mtl']);
  expect(normal.textured.asked).toEqual(spiderSidecarFixtures.map(([name]) => name));
  expect(normal.textured.members).toEqual([
    'model.usda',
    'textures/SpiderTex.jpg',
    'textures/drkwood2.jpg',
    'textures/engineflare1.jpg',
    'textures/wal67ar_small.jpg',
    'textures/wal69ar_small.jpg',
  ]);
  expect(normal.textureRejected.code).toBe('RESOLVE_FAILED');
  expect(leafName(normal.textureRejected.fileName)).toBe('SpiderTex.jpg');
  expect(normal.textureAborted.recovered).toEqual(normal.textured.bytes);
  expect(normal.textureAborted.members).toEqual(normal.textured.members);
  expect(normal.rejected).toMatchObject({ code: 'RESOLVE_FAILED', fileName: 'cube_usemtl.mtl' });
  expect(normal.missing.code).toBe('IMPORT_FAILED');
  expect(normal.importFailed.code).toBe('IMPORT_FAILED');
  expect(normal.exportFailed).toMatchObject({ code: 'EXPORT_FAILED', format: '3mf', formatIndex: 0 });
});
