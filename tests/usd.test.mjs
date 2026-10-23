// USD through the shipped facade: every USD export round-trips, USDA pulls
// USDA, USDC and MaterialX sidecars through `resolve`, and the result packs
// into a self-contained USDZ that follows the package rules ARKit and Quick
// Look enforce. `scripts/usd-strict-check.py` validates the same exports with
// OpenUSD itself in CI.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAssimp } from '../src/index.ts';
import { usdaGrid, usdSidecarScene } from './generate-usd-fixture.mjs';

const MODELS = fileURLToPath(new URL('../assimp/test/models/', import.meta.url));
const load = (relative) => ({
  name: basename(relative),
  bytes: new Uint8Array(readFileSync(join(MODELS, relative))),
});
const text = (bytes) => new TextDecoder().decode(bytes);
const scene = (bytes) => JSON.parse(text(bytes));

/** Parse a USDZ's local headers and central directory without inflating anything. */
const usdzEntries = (bytes) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x0403_4b50) {
    const compression = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataOffset = offset + 30 + nameLength + extraLength;
    entries.push({ name, compression, dataOffset, data: buffer.subarray(dataOffset, dataOffset + size) });
    offset = dataOffset + size;
  }
  expect(buffer.readUInt32LE(offset), 'central directory follows the members').toBe(0x0201_4b50);
  return entries;
};

/** The package rules from the USDZ spec that ARKit and Quick Look enforce. */
const expectArkitPackage = (bytes) => {
  const entries = usdzEntries(bytes);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry.compression, `${entry.name} is stored`).toBe(0);
    expect(entry.dataOffset % 64, `${entry.name} is 64-byte aligned`).toBe(0);
    expect(entry.name.startsWith('/') || entry.name.includes('..'), entry.name).toBe(false);
  }
  const [root, ...members] = entries;
  expect(root.name).toMatch(/\.usdc$/u);
  expect(root.data.subarray(0, 8).toString('latin1')).toBe('PXR-USDC');
  for (const member of members) expect(member.name).toMatch(/\.(?:usdc|usda|png|jpe?g)$/iu);
  return entries;
};

let assimp;

beforeAll(async () => {
  assimp = await createAssimp();
});

afterAll(() => {
  assimp?.dispose();
});

describe('USD export', () => {
  it('compiles the USDA, USDC and USDZ exporters', () => {
    const ids = assimp.formats.export.map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining(['usda', 'usdc', 'usdz']));
  });

  it.each(['usda', 'usdc', 'usdz'])('round-trips a textured glTF through %s', async (to) => {
    const source = load('glTF2/BoxTextured-glTF-Binary/BoxTextured.glb');
    const reference = scene((await assimp.convert(source, { to: 'assjson' })).files[0].bytes);
    const { files } = await assimp.convert(source, { to });
    expect(files[0].name).toBe(`result.${to}`);
    if (to === 'usdc') expect(text(files[0].bytes.subarray(0, 8))).toBe('PXR-USDC');
    if (to === 'usda') expect(text(files[0].bytes.subarray(0, 10))).toBe('#usda 1.0\n');
    if (to === 'usdz') expectArkitPackage(files[0].bytes);
    const sidecars = new Map(files.slice(1).map(({ name, bytes }) => [name, bytes]));
    const back = scene(
      (
        await assimp.convert(files[0], {
          to: 'assjson',
          resolve: (name) => sidecars.get(name.replace(/^\.\//u, '')),
        })
      ).files[0].bytes,
    );
    expect(back.meshes).toHaveLength(reference.meshes.length);
    expect(back.meshes[0].faces).toHaveLength(reference.meshes[0].faces.length);
    expect(back.materials.length).toBeGreaterThanOrEqual(1);
  });

  it('reads its own USDC output back byte-identically through a second USDC export', async () => {
    const first = (await assimp.convert(load('glTF2/simple_skin/quad_skin.glb'), { to: 'usdc' })).files[0];
    const second = (await assimp.convert(first, { to: 'usdc' })).files[0];
    const third = (await assimp.convert(second, { to: 'usdc' })).files[0];
    expect(third.bytes).toEqual(second.bytes);
  });

  it('streams a 65,536-vertex grid to USDZ and back', async () => {
    const grid = { name: 'grid.usda', bytes: usdaGrid(256) };
    const { files } = await assimp.convert(grid, { to: 'usdz' });
    expectArkitPackage(files[0].bytes);
    const back = scene((await assimp.convert(files[0], { to: 'assjson' })).files[0].bytes);
    expect(back.meshes[0].vertices.length / 3).toBeGreaterThanOrEqual(255 * 255);
  });
});

describe('USD sidecars', () => {
  const sidecarScene = () => {
    const { root, sidecars } = usdSidecarScene();
    const requested = [];
    const resolve = (name) => {
      requested.push(name);
      return sidecars.get(name.replace(/^\.\//u, ''));
    };
    return { root, sidecars, requested, resolve };
  };

  it('resolves USDA sublayers, USDA references and MaterialX documents on demand', async () => {
    const { root, requested, resolve } = sidecarScene();
    const { files } = await assimp.convert(root, { to: 'assjson', resolve });
    const imported = scene(files[0].bytes);
    expect(requested.map((name) => name.replace(/^\.\//u, ''))).toEqual(
      expect.arrayContaining(['layers/base.usda', 'parts/part.usda', 'materials/brass.mtlx']),
    );
    expect(imported.meshes).toHaveLength(2);
    const brass = imported.materials.find((material) =>
      material.properties.some(({ key, value }) => key === '?mat.name' && value === 'Brass'),
    );
    expect(brass, 'the MaterialX material reaches the scene').toBeDefined();
  });

  it('resolves a USDC reference from USDA', async () => {
    const part = (await assimp.convert(load('glTF2/BoxTextured-glTF-Binary/BoxTextured.glb'), { to: 'usdc' }))
      .files;
    const sidecars = new Map(
      part.map(({ name, bytes }) => [name === 'result.usdc' ? 'part.usdc' : name, bytes]),
    );
    const root = {
      name: 'root.usda',
      bytes: new TextEncoder().encode(
        '#usda 1.0\n(\n    defaultPrim = "World"\n)\n\ndef Xform "World"\n{\n' +
          '    def Xform "Box" (\n        prepend references = @./part.usdc@\n    )\n    {\n    }\n}\n',
      ),
    };
    const requested = [];
    const { files } = await assimp.convert(root, {
      to: 'assjson',
      resolve: (name) => {
        requested.push(name);
        return sidecars.get(name.replace(/^\.\//u, ''));
      },
    });
    expect(requested.map((name) => name.replace(/^\.\//u, ''))).toContain('part.usdc');
    expect(scene(files[0].bytes).meshes).toHaveLength(1);
  });

  it('packs a composed USDA and its sidecars into one self-contained USDZ', async () => {
    const { root, resolve } = sidecarScene();
    const { files } = await assimp.convert(root, { to: 'usdz', resolve });
    expect(files).toHaveLength(1);
    const entries = expectArkitPackage(files[0].bytes);
    for (const entry of entries.filter(({ name }) => name.endsWith('.usda'))) {
      expect(text(entry.data)).not.toMatch(/@\.\/(?:layers|parts|materials)\//u);
    }
    // The package needs nothing outside itself.
    const back = await assimp.convert(files[0], {
      to: 'assjson',
      resolve: (name) => {
        throw new Error(`self-contained USDZ asked for ${name}`);
      },
    });
    expect(scene(back.files[0].bytes).meshes).toHaveLength(2);
  });

  it('reports a missing sidecar without failing the conversion', async () => {
    const { root } = sidecarScene();
    const { files } = await assimp.convert(root, { to: 'assjson', resolve: () => undefined });
    expect(scene(files[0].bytes).meshes?.length ?? 0).toBeLessThan(2);
  });
});
