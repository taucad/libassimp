// Deterministic large inputs for the format matrix's large tier.
//
// Every mesh format gets the same side x side vertex grid: positions
// (column, height, row) with the height pattern of tests/generate-usd-fixture.mjs,
// a +Y normal and per-vertex UVs where the format carries them. The files are
// generated at run time and never committed. Formats with no simple writer
// here (Collada, FBX, USDC, USDZ) are derived by converting a generated file
// with one build; the report records every input's SHA-256, so two builds are
// only compared on byte-identical inputs.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { usdaGrid } from '../tests/generate-usd-fixture.mjs';

/** Bump when a generator's bytes change, so cached input directories are rebuilt. */
export const GENERATOR_VERSION = 1;

const height = (row, column) => ((row * 7 + column * 13) % 17) / 170;

/** Writes `chunks()` (an iterator of strings) to `path` in bounded pieces. */
const writeText = (path, chunks) => {
  const file = openSync(path, 'w');
  try {
    let parts = [];
    let size = 0;
    for (const chunk of chunks) {
      parts.push(chunk);
      size += chunk.length;
      if (size > 1 << 22) {
        writeSync(file, parts.join(''));
        parts = [];
        size = 0;
      }
    }
    writeSync(file, parts.join(''));
  } finally {
    closeSync(file);
  }
};

/** Wavefront OBJ: quads with shared v/vt/vn indices. */
const obj = function* (side) {
  yield '# libassimp format-matrix grid\no grid\n';
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) yield `v ${column} ${height(row, column)} ${row}\n`;
  }
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      yield `vt ${column / (side - 1)} ${row / (side - 1)}\n`;
    }
  }
  yield 'vn 0 1 0\n';
  for (let row = 0; row < side - 1; row += 1) {
    for (let column = 0; column < side - 1; column += 1) {
      const a = row * side + column + 1;
      const b = a + side;
      yield `f ${a}/${a}/1 ${b}/${b}/1 ${b + 1}/${b + 1}/1 ${a + 1}/${a + 1}/1\n`;
    }
  }
};

/** The two triangles of each grid cell, as vertex indices. */
const triangles = (side) => {
  const indices = new Uint32Array((side - 1) * (side - 1) * 6);
  let offset = 0;
  for (let row = 0; row < side - 1; row += 1) {
    for (let column = 0; column < side - 1; column += 1) {
      const a = row * side + column;
      const b = a + side;
      indices.set([a, b, b + 1, a, b + 1, a + 1], offset);
      offset += 6;
    }
  }
  return indices;
};

const positions = (side) => {
  const values = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      values.set([column, height(row, column), row], (row * side + column) * 3);
    }
  }
  return values;
};

/** Binary little-endian PLY: indexed triangles, positions only. */
const ply = (side) => {
  const indices = triangles(side);
  const faces = indices.length / 3;
  const header = Buffer.from(
    `ply\nformat binary_little_endian 1.0\ncomment libassimp format-matrix grid\nelement vertex ${side * side}\n` +
      `property float x\nproperty float y\nproperty float z\nelement face ${faces}\n` +
      'property list uchar uint vertex_indices\nend_header\n',
  );
  const body = Buffer.alloc(side * side * 12 + faces * 13);
  Buffer.from(positions(side).buffer).copy(body);
  let offset = side * side * 12;
  for (let face = 0; face < faces; face += 1) {
    body.writeUInt8(3, offset);
    body.writeUInt32LE(indices[face * 3], offset + 1);
    body.writeUInt32LE(indices[face * 3 + 1], offset + 5);
    body.writeUInt32LE(indices[face * 3 + 2], offset + 9);
    offset += 13;
  }
  return Buffer.concat([header, body]);
};

/** Binary STL: un-indexed triangles with a +Y facet normal. */
const stl = (side) => {
  const indices = triangles(side);
  const points = positions(side);
  const faces = indices.length / 3;
  const bytes = Buffer.alloc(84 + faces * 50);
  bytes.write('libassimp format-matrix grid', 0);
  bytes.writeUInt32LE(faces, 80);
  let offset = 84;
  for (let face = 0; face < faces; face += 1) {
    bytes.writeFloatLE(1, offset + 4);
    offset += 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[face * 3 + corner] * 3;
      bytes.writeFloatLE(points[vertex], offset);
      bytes.writeFloatLE(points[vertex + 1], offset + 4);
      bytes.writeFloatLE(points[vertex + 2], offset + 8);
      offset += 12;
    }
    offset += 2;
  }
  return bytes;
};

/** glTF 2.0 document and binary buffer: POSITION, NORMAL, TEXCOORD_0 and uint32 indices. */
const gltfParts = (side) => {
  const count = side * side;
  const position = positions(side);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let vertex = 0; vertex < count; vertex += 1) {
    normal[vertex * 3 + 1] = 1;
    uv[vertex * 2] = (vertex % side) / (side - 1);
    uv[vertex * 2 + 1] = Math.floor(vertex / side) / (side - 1);
  }
  const indices = triangles(side);
  const views = [position, normal, uv, indices].map((array) => Buffer.from(array.buffer));
  let byteOffset = 0;
  const bufferViews = views.map((view, index) => {
    const entry = { buffer: 0, byteOffset, byteLength: view.length, target: index === 3 ? 34_963 : 34_962 };
    byteOffset += view.length;
    return entry;
  });
  const json = {
    asset: { version: '2.0', generator: 'libassimp format-matrix grid' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'grid' }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] },
    ],
    materials: [
      {
        name: 'surface',
        pbrMetallicRoughness: { baseColorFactor: [0.8, 0.5, 0.2, 1], roughnessFactor: 0.4 },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [side - 1, Math.fround(16 / 170), side - 1],
      },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };
  return { json, bin: Buffer.concat(views) };
};

const glb = (side) => {
  const { json, bin } = gltfParts(side);
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const chunk = (length, type) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(length, 0);
    header.writeUInt32LE(type, 4);
    return header;
  };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46_54_6c_67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  return Buffer.concat([
    header,
    chunk(text.length, 0x4e_4f_53_4a),
    text,
    chunk(bin.length, 0x00_4e_49_42),
    bin,
  ]);
};

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Generated large inputs, keyed by format id. Each entry lists the entry file
 * first, then its sidecars.
 */
export const GENERATED = {
  obj: { files: ['grid.obj'], write: (directory, side) => writeText(join(directory, 'grid.obj'), obj(side)) },
  ply: {
    files: ['grid.ply'],
    write: (directory, side) => writeFileSync(join(directory, 'grid.ply'), ply(side)),
  },
  stl: {
    files: ['grid.stl'],
    write: (directory, side) => writeFileSync(join(directory, 'grid.stl'), stl(side)),
  },
  glb: {
    files: ['grid.glb'],
    write: (directory, side) => writeFileSync(join(directory, 'grid.glb'), glb(side)),
  },
  gltf: {
    files: ['grid.gltf', 'grid.bin'],
    write: (directory, side) => {
      const { json, bin } = gltfParts(side);
      json.buffers[0].uri = 'grid.bin';
      writeFileSync(join(directory, 'grid.gltf'), JSON.stringify(json));
      writeFileSync(join(directory, 'grid.bin'), bin);
    },
  },
  usda: {
    files: ['grid.usda'],
    write: (directory, side) => writeFileSync(join(directory, 'grid.usda'), usdaGrid(side)),
  },
};

/** Inputs converted from a generated one by the producing build. */
export const DERIVED = {
  dae: { from: 'glb', file: 'grid.dae' },
  fbx: { from: 'glb', file: 'grid.fbx' },
  usdc: { from: 'usda', file: 'grid.usdc' },
  usdz: { from: 'usda', file: 'grid.usdz' },
};

/** Writes every generated input into `directory` and returns their SHA-256 digests. */
export const writeGenerated = (directory, side) => {
  const digests = {};
  for (const [, { files, write }] of Object.entries(GENERATED)) {
    write(directory, side);
    for (const file of files) digests[file] = sha256(join(directory, file));
  }
  return digests;
};

export { sha256 as fileSha256 };
