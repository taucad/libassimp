// Behaviour matrix over the engine's own fixture corpus: one import per
// enabled importer, one export per enabled exporter, the entry-specific
// subsets, and the export properties the exporters honour. Every primary
// output is fingerprinted in `determinism.json`, so an engine or flag change
// that alters bytes fails here instead of downstream. Re-record deliberate
// changes with LIBASSIMP_RECORD_DETERMINISM=1 (see CONTRIBUTING.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAssimp } from '../src/index.ts';
import { createAssimp as createExporter } from '../src/exporter.ts';
import { createAssimp as createImporter } from '../src/importer.ts';
import { fnv64 } from './fnv64.mjs';

const MODELS = fileURLToPath(new URL('../assimp/test/models/', import.meta.url));
const load = (relative) => ({
  name: basename(relative),
  bytes: new Uint8Array(readFileSync(join(MODELS, relative))),
});
const text = (bytes) => new TextDecoder().decode(bytes);

// One representative fixture per importer the reference suite exercised.
// `error` marks the formats `variants.json` disables and the fixtures assimp
// itself refuses; `empty` marks a scene that parses without geometry.
const IMPORTS = [
  ['3D', ['3D/box.uc', '3D/box_a.3d', '3D/box_d.3d']],
  ['3DS', ['3DS/test1.3ds']],
  ['3MF', ['3MF/box.3mf']],
  ['AC', ['AC/SphereWithLight.ac']],
  ['AMF', ['AMF/test1.amf']],
  ['ASE', ['ASE/ThreeCubesGreen.ASE']],
  ['B3D', ['B3D/WusonBlitz.b3d']],
  ['BLEND', ['BLEND/box.blend']],
  ['BVH', ['BVH/Boxing_Toes.bvh']],
  ['COB', ['COB/molecule.cob']],
  ['COLLADA', ['Collada/duck.dae']],
  ['CSM', ['CSM/ThomasFechten.csm']],
  ['DXF', ['DXF/PinkEggFromLW.dxf']],
  ['FBX', ['FBX/box.fbx']],
  ['FBX ascii', ['FBX/embedded_ascii/box.FBX']],
  ['glTF', ['glTF/BoxTextured-glTF/BoxTextured.gltf', 'glTF/BoxTextured-glTF/BoxTextured.bin']],
  ['glTF2', ['glTF2/BoxTextured-glTF-Binary/BoxTextured.glb']],
  ['HMP', ['HMP/terrain.hmp']],
  ['IFC', ['IFC/cube-blender-IFC4.ifc']],
  ['IQM', ['IQM/mrfixit.iqm']],
  ['LWO', ['LWO/LWO2/hierarchy.lwo']],
  ['MD2', ['MD2/faerie.md2']],
  ['MD5', ['MD5/SimpleCube.md5mesh']],
  ['MDC', ['MDC/spider.mdc']],
  ['MDL HL1', ['MDL/MDL (HL1)/chrome_sphere.mdl']],
  ['MDL3', ['MDL/MDL3 (3DGS A4)/minigun.MDL']],
  ['MDL5', ['MDL/MDL5 (3DGS A5)/minigun_mdl5.mdl']],
  ['MDL7', ['MDL/MDL7 (3DGS A7)/Sphere_DiffPinkBlueSpec_Alpha90.mdl']],
  ['MS3D', ['MS3D/twospheres.ms3d']],
  ['NFF', ['NFF/cylinder.nff']],
  ['OBJ', ['OBJ/cube_usemtl.obj', 'OBJ/cube_usemtl.mtl']],
  ['OFF', ['OFF/Cube.off']],
  ['Ogre', ['Ogre/TheThing/Mesh.mesh.xml', 'Ogre/TheThing/BlockMat.material']],
  ['OpenGEX', ['OpenGEX/Example.ogex']],
  ['PLY', ['PLY/cube.ply']],
  ['PLY binary', ['PLY/cube_binary.ply']],
  ['Q3D', ['Q3D/earth.q3o']],
  ['SIB', ['SIB/heffalump.sib']],
  ['SMD', ['SMD/triangle.smd']],
  ['STL ascii', ['STL/Spider_ascii.stl']],
  ['STL binary', ['STL/Spider_binary.stl']],
  ['USDA', ['../models-nonbsd/USD/usda/texturedcube.usda']],
  ['USDC', ['../models-nonbsd/USD/usdc/texturedcube.usdc']],
  ['USDZ', ['../models-nonbsd/USD/usdz/damaged-helmet-gltf.usdz']],
  ['VRML', ['WRL/Wuson.wrl']],
  ['X', ['X/test_cube_text.x']],
  ['X binary', ['X/test_cube_binary.x']],
  ['X3D', ['X3D/HelloWorld.x3d']],
  // The engine fork parses binary X3D, and hands back a scene with no geometry.
  ['X3DB', ['X3DB/HelloWorld.x3db'], 'empty'],
  ['XGL', ['XGL/sample_official.xgl']],
  ['IRR', ['IRR/box.irr'], 'error'],
  ['IRRMesh', ['IRRMesh/spider.irrmesh'], 'error'],
  ['M3D', ['M3D/cube_usemtl.m3d'], 'error'],
  ['RAW', ['RAW/WithColor.raw'], 'error'],
  ['TERRAGEN', ['TER/RealisticTerrain.ter'], 'error'],
  ['glTF2 Draco', ['glTF2/draco/robot.glb'], 'error'],
  ['not a model', ['3DS/test.png'], 'error'],
];

const EXPORT_SOURCE = 'glTF2/simple_skin/quad_skin.glb';
const TEXTURED_SOURCE = 'glTF2/BoxTextured-glTF-Binary/BoxTextured.glb';

// Exporters that stamp the wall-clock time into their output: their bytes are
// never equal twice, so the matrix asserts their shape instead of a hash.
const TIMESTAMPED = new Set(['3mf', 'collada', 'fbx', 'fbxa', 'stp']);

const fingerprints = fileURLToPath(new URL('./determinism.json', import.meta.url));
const recorded = JSON.parse(readFileSync(fingerprints, 'utf8'));
const recording = process.env['LIBASSIMP_RECORD_DETERMINISM'] === '1';
const observed = {};

/** Pin one primary output's fingerprint, or record it when re-recording. */
const pin = (id, bytes) => {
  const hash = fnv64(bytes);
  observed[id] = hash;
  if (recording) return;
  expect(hash, `${id} output bytes changed; re-record deliberately`).toBe(recorded[id]);
};

/** Read `3D/3dmodel.model` out of a 3MF, which is a ZIP of local file entries. */
const modelXml = (zip) => {
  const buffer = Buffer.from(zip);
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x0403_4b50) {
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const data = buffer.subarray(start, start + compressedSize);
    if (name.endsWith('3D/3dmodel.model')) {
      return (compression === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    offset = start + compressedSize;
  }
  throw new Error('3D/3dmodel.model not found in the 3MF archive');
};

const maxVertexDigits = (xml) =>
  [...xml.matchAll(/<vertex\s+[^>]*?[xyz]="-?\d+(?:\.(\d+))?"/gu)].reduce(
    (widest, match) => Math.max(widest, match[1]?.length ?? 0),
    0,
  );

let assimp;
let exporter;
let importer;

beforeAll(async () => {
  [assimp, exporter, importer] = await Promise.all([createAssimp(), createExporter(), createImporter()]);
});

afterAll(() => {
  assimp?.dispose();
  exporter?.dispose();
  importer?.dispose();
  if (recording) {
    const sorted = Object.fromEntries(
      Object.entries(observed).sort(([left], [right]) => (left < right ? -1 : 1)),
    );
    writeFileSync(fingerprints, `${JSON.stringify(sorted, null, 2)}\n`);
  }
});

describe('importers', () => {
  it.each(IMPORTS)('reads %s', async (id, files, outcome) => {
    const inputs = files.map(load);
    if (outcome === 'error') {
      await expect(assimp.convert(inputs, { to: 'assjson' })).rejects.toMatchObject({
        code: 'IMPORT_FAILED',
      });
      return;
    }
    const { files: outputs } = await assimp.convert(inputs, { to: 'assjson' });
    const meshes = JSON.parse(text(outputs[0].bytes)).meshes?.length ?? 0;
    if (outcome === 'empty') expect(meshes).toBe(0);
    else expect(meshes, `${id} imported without meshes`).toBeGreaterThan(0);
    pin(`import ${id}`, outputs[0].bytes);
  });

  it('takes the entry file from the first element, whatever the order', async () => {
    const obj = load('OBJ/cube_usemtl.obj');
    const mtl = load('OBJ/cube_usemtl.mtl');
    const first = await assimp.convert([obj, mtl], { to: 'assjson' });
    const second = await assimp.convert([obj, mtl].reverse().reverse(), { to: 'assjson' });
    expect(first.files[0].bytes).toEqual(second.files[0].bytes);
    await expect(assimp.convert([mtl, obj], { to: 'assjson' })).rejects.toMatchObject({
      code: 'IMPORT_FAILED',
    });
  });
});

describe('exporters', () => {
  it('writes every compiled exporter from one imported scene', async () => {
    const source = load(EXPORT_SOURCE);
    for (const { id, extension } of assimp.formats.export) {
      const { files } = await assimp.convert(source, { to: id });
      expect(files[0].name, `${id} output name`).toBe(`result.${extension}`);
      expect(files[0].bytes.byteLength, `${id} output size`).toBeGreaterThan(0);
      if (!TIMESTAMPED.has(id)) pin(`export ${id}`, files[0].bytes);
    }
  });

  it('returns the sidecars each exporter writes beside the primary output', async () => {
    const source = load(EXPORT_SOURCE);
    const obj = await assimp.convert(source, { to: 'obj' });
    expect(obj.files.map(({ name }) => name)).toEqual(['result.obj', 'result.mtl']);
    const gltf = await assimp.convert(source, { to: 'gltf' });
    expect(gltf.files.map(({ name }) => name)).toEqual(['result.gltf', 'result.bin']);
    const dae = await assimp.convert(load(TEXTURED_SOURCE), { to: 'dae' });
    expect(dae.files.map(({ name }) => name)).toEqual(['result.dae', 'result.dae/result_texture_0001.png']);
  });
});

describe('entries', () => {
  it.each([
    ['OBJ/cube_usemtl.obj'],
    ['FBX/box.fbx'],
    ['Collada/duck.dae'],
    ['STL/Spider_binary.stl'],
    ['PLY/cube.ply'],
  ])('reads %s and writes glb through libassimp/importer', async (relative) => {
    const { files } = await importer.convert(load(relative), { to: 'glb' });
    expect(text(files[0].bytes.subarray(0, 4))).toBe('glTF');
    pin(`importer ${basename(relative)}`, files[0].bytes);
  });

  it('writes every compiled exporter from glb through libassimp/exporter', async () => {
    const source = load(TEXTURED_SOURCE);
    for (const { id, extension } of exporter.formats.export) {
      const { files } = await exporter.convert(source, { to: id });
      expect(files[0].name, `${id} output name`).toBe(`result.${extension}`);
    }
  });

  it('refuses a format its build left out', async () => {
    await expect(importer.convert(load(EXPORT_SOURCE), { to: 'stl' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    await expect(exporter.convert(load('OBJ/cube_usemtl.obj'), { to: 'glb' })).rejects.toMatchObject({
      code: 'IMPORT_FAILED',
    });
  });
});

describe('export properties', () => {
  const source = () => load(TEXTURED_SOURCE);

  it('pretty-prints assjson when JSON_SKIP_WHITESPACES is false', async () => {
    const compact = await assimp.convert(source(), { to: 'assjson' });
    const pretty = await assimp.convert(source(), {
      to: 'assjson',
      properties: { JSON_SKIP_WHITESPACES: false },
    });
    expect(pretty.files[0].bytes.byteLength).toBeGreaterThan(compact.files[0].bytes.byteLength);
    expect(text(compact.files[0].bytes)).not.toContain('\n');
    expect(JSON.parse(text(pretty.files[0].bytes))).toEqual(JSON.parse(text(compact.files[0].bytes)));
  });

  it('switches the X file header with EXPORT_XFILE_64BIT', async () => {
    const plain = await assimp.convert(source(), { to: 'x' });
    const wide = await assimp.convert(source(), { to: 'x', properties: { EXPORT_XFILE_64BIT: true } });
    expect(text(plain.files[0].bytes)).toContain('xof 0303txt 0032');
    expect(text(wide.files[0].bytes)).toContain('xof 0303txt 0064');
  });

  it('ignores unknown property keys', async () => {
    const plain = await assimp.convert(source(), { to: 'assjson' });
    const noisy = await assimp.convert(source(), {
      to: 'assjson',
      properties: { NONEXISTENT_PROPERTY: true, FAKE_COUNT: 42, FAKE_NAME: 'x' },
    });
    expect(noisy.files[0].bytes).toEqual(plain.files[0].bytes);
  });

  it('defaults 3MF to millimeter and takes the unit from 3MF_EXPORT_UNIT', async () => {
    const fallback = await assimp.convert(source(), { to: '3mf' });
    expect(modelXml(fallback.files[0].bytes)).toContain('unit="millimeter"');
    for (const unit of ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter']) {
      const result = await assimp.convert(source(), { to: '3mf', properties: { '3MF_EXPORT_UNIT': unit } });
      expect(modelXml(result.files[0].bytes)).toContain(`unit="${unit}"`);
    }
  });

  it('writes Application metadata only when 3MF_EXPORT_APPLICATION is given', async () => {
    const fallback = await assimp.convert(source(), { to: '3mf' });
    expect(modelXml(fallback.files[0].bytes)).not.toContain('name="Application"');
    const named = await assimp.convert(source(), {
      to: '3mf',
      properties: { '3MF_EXPORT_APPLICATION': 'TestSlicer 1.0' },
    });
    const xml = modelXml(named.files[0].bytes);
    expect(xml).toContain('name="Application"');
    expect(xml).toContain('TestSlicer 1.0');
  });

  it('scales 3MF vertex precision with 3MF_EXPORT_DECIMAL_PRECISION', async () => {
    const cylinders = load('glTF2/2CylinderEngine-glTF-Binary/2CylinderEngine.glb');
    const fallback = await assimp.convert(cylinders, { to: '3mf' });
    expect(maxVertexDigits(modelXml(fallback.files[0].bytes))).toBeGreaterThanOrEqual(9);
    const wide = await assimp.convert(cylinders, {
      to: '3mf',
      properties: { '3MF_EXPORT_DECIMAL_PRECISION': 12 },
    });
    expect(maxVertexDigits(modelXml(wide.files[0].bytes))).toBeGreaterThanOrEqual(10);
    const narrow = await assimp.convert(cylinders, {
      to: '3mf',
      properties: { '3MF_EXPORT_DECIMAL_PRECISION': 3 },
    });
    expect(maxVertexDigits(modelXml(narrow.files[0].bytes))).toBeLessThanOrEqual(3);
  });

  it('fails the export when 3MF_EXPORT_DECIMAL_PRECISION is out of range', async () => {
    for (const precision of [0, 17]) {
      await expect(
        assimp.convert(source(), { to: '3mf', properties: { '3MF_EXPORT_DECIMAL_PRECISION': precision } }),
      ).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    }
  });
});
