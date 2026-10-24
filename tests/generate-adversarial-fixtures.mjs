#!/usr/bin/env node

// Hostile-input fixtures: scene graphs and file syntax nested far deeper than
// any real asset, which overflowed the native stack (SIGSEGV) or the Wasm/V8
// call stack (RangeError) before the engine capped nesting depth. Generated, so
// no third-party asset is redistributed and any depth can be produced.
// `node tests/generate-adversarial-fixtures.mjs --out <dir> [--depth N]...` writes
// every fixture at each depth; the test suites import the generators directly.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The engine's scene-graph nesting cap (`AI_CONFIG_IMPORT_MAX_NODE_DEPTH` default). */
export const MAX_NODE_DEPTH = 1000;

/**
 * A depth every importer accepts: LightUSD stops USDA prim nesting at 512, and
 * FBX and COLLADA wrap the chain in extra scene nodes.
 */
export const SAFE_NODE_DEPTH = 500;

/** Far past every cap, and deep enough to overflow an uncapped reader. */
export const HOSTILE_NODE_DEPTH = 20_000;

const encoder = new TextEncoder();

/** One triangle: positions, then three uint16 indices padded to 4 bytes. */
const triangleBuffer = () => {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(index * 4, value, true));
  [0, 1, 2].forEach((value, index) => view.setUint16(36 + index * 2, value, true));
  return bytes;
};

/**
 * glTF 2.0 whose nodes form one chain `depth` levels deep, with a triangle mesh
 * on the deepest node. `cycle` closes the chain back onto its root instead.
 */
export const deepGltf = (depth, { cycle = false } = {}) => {
  const nodes = Array.from({ length: depth }, (_, index) => ({
    name: `n${index}`,
    ...(index + 1 < depth ? { children: [index + 1] } : cycle ? { children: [0] } : { mesh: 0 }),
  }));
  const buffer = triangleBuffer();
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [
      {
        byteLength: buffer.byteLength,
        uri: `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`,
      },
    ],
  };
  return encoder.encode(JSON.stringify(json));
};

/** COLLADA whose `<node>` elements nest `depth` levels, with a triangle on the deepest one. */
const deepCollada = (depth) => {
  const open = Array.from({ length: depth }, (_, index) => `<node id="n${index}" name="n${index}">`).join('');
  const close = '</node>'.repeat(depth);
  return encoder.encode(
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">' +
      '<asset><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>' +
      '<library_geometries><geometry id="tri"><mesh>' +
      '<source id="tri-pos"><float_array id="tri-pos-array" count="9">0 0 0 1 0 0 0 1 0</float_array>' +
      '<technique_common><accessor source="#tri-pos-array" count="3" stride="3">' +
      '<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>' +
      '</accessor></technique_common></source>' +
      '<vertices id="tri-vtx"><input semantic="POSITION" source="#tri-pos"/></vertices>' +
      '<triangles count="1"><input semantic="VERTEX" source="#tri-vtx" offset="0"/><p>0 1 2</p></triangles>' +
      '</mesh></geometry></library_geometries>' +
      `<library_visual_scenes><visual_scene id="scene">${open}<instance_geometry url="#tri"/>${close}` +
      '</visual_scene></library_visual_scenes>' +
      '<scene><instance_visual_scene url="#scene"/></scene></COLLADA>\n',
  );
};

/** USDA whose `def Xform` prims nest `depth` levels, with a triangle mesh in the deepest one. */
const deepUsda = (depth) => {
  const parts = ['#usda 1.0\n(\n    defaultPrim = "n0"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n'];
  for (let index = 0; index < depth; index += 1) parts.push(`def Xform "n${index}"\n{\n`);
  parts.push(
    'def Mesh "tri"\n{\n    int[] faceVertexCounts = [3]\n    int[] faceVertexIndices = [0, 1, 2]\n' +
      '    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n}\n',
  );
  parts.push('}\n'.repeat(depth));
  return encoder.encode(parts.join(''));
};

const FBX_TEMPLATE = fileURLToPath(new URL('./fixtures/cube-ascii.fbx', import.meta.url));

/**
 * ASCII FBX: the cube fixture with its mesh model hung under a chain of
 * `depth` Null models (scene-graph depth through Connections).
 */
const deepFbxModels = (depth) => {
  const text = readFileSync(FBX_TEMPLATE, 'utf8');
  const meshModel = '5882379264';
  const rootModel = '5263363584';
  const id = (index) => String(9_000_000_000 + index);
  const models = Array.from(
    { length: depth },
    (_, index) =>
      `\tModel: ${id(index)}, "Model::chain${index}", "Null" {\n\t\tVersion: 232\n\t\tShading: Y\n\t\tCulling: "CullingOff"\n\t}\n`,
  ).join('');
  const links = Array.from(
    { length: depth },
    (_, index) => `\tC: "OO",${id(index)},${index === 0 ? rootModel : id(index - 1)}\n`,
  ).join('');
  const withModels = text.replace('\tMaterial: 4882804720,', `${models}\tMaterial: 4882804720,`);
  const relinked = withModels.replace(
    `C: "OO",${meshModel},${rootModel}`,
    `C: "OO",${meshModel},${id(depth - 1)}`,
  );
  if (relinked === withModels || withModels === text)
    throw new Error('cube-ascii.fbx no longer matches the generator');
  return encoder.encode(relinked.replace('Connections:  {\n', `Connections:  {\n${links}`));
};

/** ASCII FBX: the cube fixture with one top-level scope nested `depth` levels (parser recursion). */
const deepFbxScopes = (depth) => {
  const text = readFileSync(FBX_TEMPLATE, 'utf8');
  const nested = `Nested: ${'{\nNested: '.repeat(depth)}0\n${'}\n'.repeat(depth)}`;
  const withScopes = text.replace('Objects:  {\n', `${nested}Objects:  {\n`);
  if (withScopes === text) throw new Error('cube-ascii.fbx no longer matches the generator');
  return encoder.encode(withScopes);
};

/**
 * Binary FBX 7.4 holding one record nested `depth` levels (tokenizer
 * recursion): each record's only content is the next one, closed by its
 * 13-byte null sentinel, and a null record ends the file.
 */
const deepFbxBinary = (depth) => {
  const header = 27;
  const record = 14;
  const sentinel = 13;
  const bytes = new Uint8Array(header + record * depth + sentinel * depth);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('Kaydara FBX Binary  \0\u001a\0'));
  view.setUint32(23, 7400, true);
  for (let level = 0; level < depth; level += 1) {
    const start = header + record * level;
    view.setUint32(start, start + record * (depth - level) + sentinel * (depth - 1 - level), true);
    bytes[start + 12] = 1;
    bytes[start + 13] = 0x4e;
  }
  return bytes;
};

/** Every fixture at one depth, keyed by file name. */
export const adversarialFixtures = (depth) => ({
  [`deep-${depth}.gltf`]: deepGltf(depth),
  [`deep-cycle-${depth}.gltf`]: deepGltf(depth, { cycle: true }),
  [`deep-${depth}.dae`]: deepCollada(depth),
  [`deep-${depth}.usda`]: deepUsda(depth),
  [`deep-models-${depth}.fbx`]: deepFbxModels(depth),
  [`deep-scopes-${depth}.fbx`]: deepFbxScopes(depth),
  [`deep-records-${depth}.fbx`]: deepFbxBinary(depth),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, depth: { type: 'string', multiple: true } },
  });
  if (!values.out) throw new Error('--out <dir> is required');
  mkdirSync(values.out, { recursive: true });
  for (const depth of (values.depth ?? [String(HOSTILE_NODE_DEPTH), String(SAFE_NODE_DEPTH)]).map(Number)) {
    for (const [name, bytes] of Object.entries(adversarialFixtures(depth)))
      writeFileSync(join(values.out, name), bytes);
  }
}
