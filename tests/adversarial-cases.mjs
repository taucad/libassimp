// Hostile inputs for both backends: deep nesting, archive and stream bombs,
// oversized counts, and truncated or garbage files per format. Large inputs are
// generated at run time from a size parameter; scripts/generate-fuzz-corpus.mjs
// calls the same generators with small parameters to seed the fuzzer.
//
// Each case is { id, family, needs, generate(scale) } and generate returns
// { files: [{ name, bytes }], to }. `scale` is 'full' for the parity suite and
// 'seed' for the fuzz corpus. `needs` (from KNOWN_FAILURES) names the engine or
// runtime change a failing case waits on, so a failure says which workstream
// has to land.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, crc32, deflateRawSync } from 'node:zlib';

const MODELS = fileURLToPath(new URL('../assimp/test/models/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

const encoder = new TextEncoder();
const utf8 = (text) => encoder.encode(text);
const concat = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const MIB = 1024 * 1024;

/** Raw-deflate `prefix` followed by `zeros` zero bytes without materialising them. */
const deflatedZeros = (prefix, zeros) => {
  const chunk = new Uint8Array(Math.min(zeros, 64 * MIB));
  if (zeros <= chunk.length) {
    const stream = deflateRawSync(concat([prefix, new Uint8Array(zeros)]), { level: 9 });
    let crc = crc32(prefix);
    crc = crc32(new Uint8Array(zeros), crc);
    return { data: stream, crc, size: prefix.length + zeros };
  }
  // Large bombs: a full-flushed block sequence for the prefix, the same
  // full-flushed sequence for one 64 MiB zero chunk repeated, then a final
  // block. A full flush resets the dictionary, so the concatenation is one
  // valid stream and the bomb itself is never allocated.
  const flushed = (bytes) => deflateRawSync(bytes, { level: 9, finishFlush: constants.Z_FULL_FLUSH });
  const head = flushed(prefix);
  const body = flushed(chunk);
  const count = Math.floor(zeros / chunk.length);
  const rest = zeros - count * chunk.length;
  const tail = deflateRawSync(new Uint8Array(rest), { level: 9 });
  let crc = crc32(prefix);
  for (let index = 0; index < count; index += 1) crc = crc32(chunk, crc);
  crc = crc32(new Uint8Array(rest), crc);
  return {
    data: concat([head, ...Array.from({ length: count }, () => body), tail]),
    crc,
    size: prefix.length + zeros,
  };
};

/**
 * Minimal ZIP writer: stored or raw-deflated entries, optional size lies.
 * entries: [{ name, bytes } | { name, deflated: { data, crc, size }, declaredSize? }]
 */
const zip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = utf8(entry.name);
    const method = entry.deflated ? 8 : 0;
    const data = entry.deflated ? entry.deflated.data : entry.bytes;
    const crc = entry.deflated ? entry.deflated.crc : crc32(entry.bytes);
    const size = entry.declaredSize ?? (entry.deflated ? entry.deflated.size : entry.bytes.length);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc >>> 0, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, size >>> 0, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(10, method, true);
    central.setUint32(16, crc >>> 0, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, size >>> 0, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const directory = concat(centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, directory, new Uint8Array(end.buffer)]);
};

// Sizes. `full` matches the review's probes (a 20,000-deep chain kills native);
// `seed` keeps every corpus file small enough to check in.
const DEPTH = { full: 20_000, seed: 64 };
const BOMB = { full: 1024 * MIB, seed: 4 * MIB };
const BASE64 = { full: 64 * MIB, seed: 4096 };

const deep = (open, close, depth) => open.repeat(depth) + close.repeat(depth);

const gltf = (document) => utf8(JSON.stringify({ asset: { version: '2.0' }, ...document }));

const fbxAsciiHeader =
  '; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7400\n}\n';

const colladaOpen =
  '<?xml version="1.0" encoding="utf-8"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">\n';

/** FBX 7.4 binary node record (32-bit offsets). */
const fbxNode = ({ name, properties = [], children = [] }, start) => {
  const nameBytes = utf8(name);
  const propertyBytes = concat(properties);
  const headerLength = 13 + nameBytes.length;
  const sentinel = children.length > 0 ? new Uint8Array(13) : new Uint8Array(0);
  let childOffset = start + headerLength + propertyBytes.length;
  const childBytes = [];
  for (const child of children) {
    const bytes = child(childOffset);
    childBytes.push(bytes);
    childOffset += bytes.length;
  }
  const end = childOffset + sentinel.length;
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, end, true);
  header.setUint32(4, properties.length, true);
  header.setUint32(8, propertyBytes.length, true);
  header.setUint8(12, nameBytes.length);
  return concat([new Uint8Array(header.buffer), nameBytes, propertyBytes, ...childBytes, sentinel]);
};
const fbxLong = (value) => {
  const view = new DataView(new ArrayBuffer(9));
  view.setUint8(0, 'L'.codePointAt(0));
  view.setBigInt64(1, BigInt(value), true);
  return new Uint8Array(view.buffer);
};
const fbxString = (value) => {
  const bytes = utf8(value);
  const view = new DataView(new ArrayBuffer(5));
  view.setUint8(0, 'S'.codePointAt(0));
  view.setUint32(1, bytes.length, true);
  return concat([new Uint8Array(view.buffer), bytes]);
};
const fbxDoubleArray = (declaredLength, compressed) => {
  const view = new DataView(new ArrayBuffer(13));
  view.setUint8(0, 'd'.codePointAt(0));
  view.setUint32(1, declaredLength, true);
  view.setUint32(5, 1, true);
  view.setUint32(9, compressed.length, true);
  return concat([new Uint8Array(view.buffer), compressed]);
};
/** zlib (RFC 1950) stream of `length` zero bytes; the Adler-32 of zeros is (length mod 65521) << 16 | 1. */
const zlibZeros = (length) => {
  const trailer = new DataView(new ArrayBuffer(4));
  trailer.setUint32(0, (((length % 65_521) << 16) | 1) >>> 0);
  return concat([
    new Uint8Array([0x78, 0xda]),
    deflatedZeros(new Uint8Array(0), length).data,
    new Uint8Array(trailer.buffer),
  ]);
};
const fbxInt = (value) => {
  const view = new DataView(new ArrayBuffer(5));
  view.setUint8(0, 'I'.codePointAt(0));
  view.setInt32(1, value, true);
  return new Uint8Array(view.buffer);
};
const fbxIntArray = (values) => {
  const view = new DataView(new ArrayBuffer(13 + values.length * 4));
  view.setUint8(0, 'i'.codePointAt(0));
  view.setUint32(1, values.length, true);
  view.setUint32(9, values.length * 4, true);
  values.forEach((value, index) => view.setInt32(13 + index * 4, value, true));
  return new Uint8Array(view.buffer);
};
/** Children are laid out one after another; each is given its absolute start offset. */
const fbxSiblings = (nodes, start) => {
  const output = [];
  let offset = start;
  for (const node of nodes) {
    const bytes = fbxNode(node, offset);
    output.push(bytes);
    offset += bytes.length;
  }
  return concat(output);
};
const leaf = (name, properties) => ({ name, properties });
const parent = (name, properties, nodes) => ({
  name,
  properties,
  children: nodes.map((node) => (offset) => fbxNode(node, offset)),
});
/** A minimal FBX 7.4 binary scene: one Model under the root with one Geometry whose Vertices is `vertices`. */
const fbxBinary = (vertices) => {
  const magic = concat([utf8('Kaydara FBX Binary  '), new Uint8Array([0, 0x1a, 0])]);
  const version = new Uint8Array(new Uint32Array([7400]).buffer);
  const nodes = fbxSiblings(
    [
      parent(
        'FBXHeaderExtension',
        [],
        [leaf('FBXHeaderVersion', [fbxInt(1003)]), leaf('FBXVersion', [fbxInt(7400)])],
      ),
      parent(
        'Objects',
        [],
        [
          parent(
            'Geometry',
            [fbxLong(1), fbxString('Geometry::\u0000\u0001Geometry'), fbxString('Mesh')],
            [leaf('Vertices', [vertices]), leaf('PolygonVertexIndex', [fbxIntArray([0, 1, -3])])],
          ),
          parent(
            'Model',
            [fbxLong(2), fbxString('Model::\u0000\u0001Model'), fbxString('Mesh')],
            [leaf('Version', [fbxInt(232)])],
          ),
        ],
      ),
      parent(
        'Connections',
        [],
        [
          leaf('C', [fbxString('OO'), fbxLong(1), fbxLong(2)]),
          leaf('C', [fbxString('OO'), fbxLong(2), fbxLong(0)]),
        ],
      ),
    ],
    magic.length + version.length,
  );
  return concat([magic, version, nodes, new Uint8Array(13)]);
};

const lcg = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 24;
  };
};

export const loadFixture = (relative) => {
  const path = relative.startsWith('fixtures/') ? join(FIXTURES, relative.slice(9)) : join(MODELS, relative);
  return { name: basename(path), bytes: new Uint8Array(readFileSync(path)) };
};

// One representative per format family. The formats PR-5 removes (X, X3D,
// 3DS) are left out on purpose.
export const TRUNCATION_FIXTURES = [
  'fixtures/cube.obj',
  'fixtures/cube-ascii.ply',
  'PLY/cube_binary.ply',
  'fixtures/cube-ascii.stl',
  'STL/Spider_binary.stl',
  'fixtures/cube-ascii.fbx',
  'FBX/box.fbx',
  'fixtures/cube.dae',
  'fixtures/two-material-manifold.glb',
  'glTF2/BoxTextured-glTF-Embedded/BoxTextured.gltf',
  '../models-nonbsd/USD/usda/texturedcube.usda',
  '../models-nonbsd/USD/usdc/texturedcube.usdc',
  '../models-nonbsd/USD/usdz/damaged-helmet-gltf.usdz',
  '3MF/box.3mf',
  'IFC/cube-blender-ifc4.ifc',
  'AC/SphereWithLight.ac',
  'AMF/test1.amf',
  'ASE/ThreeCubesGreen.ASE',
  'B3D/WusonBlitz.b3d',
  'BLEND/box.blend',
  'BVH/Boxing_Toes.bvh',
  'COB/molecule.cob',
  'CSM/ThomasFechten.csm',
  'DXF/PinkEggFromLW.dxf',
  'HMP/terrain.hmp',
  'IQM/mrfixit.iqm',
  'LWO/LWO2/hierarchy.lwo',
  'LWS/move_x.lws',
  'MD2/faerie.md2',
  'MD5/SimpleCube.md5mesh',
  'MDC/spider.mdc',
  'MDL/MDL (HL1)/chrome_sphere.mdl',
  'MS3D/twospheres.ms3d',
  'NFF/cylinder.nff',
  'OFF/Cube.off',
  'OpenGEX/Example.ogex',
  'Q3D/earth.q3o',
  'SIB/heffalump.sib',
  'SMD/triangle.smd',
  'WRL/Wuson.wrl',
  'XGL/sample_official.xgl',
];

const truncationCases = TRUNCATION_FIXTURES.flatMap((relative) => {
  const id = relative.replaceAll(/^.*\//gu, '').toLowerCase();
  const load = () => loadFixture(relative);
  return [
    {
      id: `truncated-half/${id}`,
      family: 'truncated',
      generate: () => {
        const { name, bytes } = load();
        return { files: [{ name, bytes: bytes.subarray(0, Math.floor(bytes.length / 2)) }], to: 'glb' };
      },
    },
    {
      id: `truncated-head/${id}`,
      family: 'truncated',
      generate: () => {
        const { name, bytes } = load();
        return { files: [{ name, bytes: bytes.subarray(0, Math.min(64, bytes.length)) }], to: 'glb' };
      },
    },
    {
      id: `garbage/${id}`,
      family: 'garbage',
      generate: () => {
        const { name, bytes } = load();
        const random = lcg(bytes.length);
        const body = Uint8Array.from({ length: 4096 }, random);
        return { files: [{ name, bytes: concat([bytes.subarray(0, 16), body]) }], to: 'glb' };
      },
    },
  ];
});

// Failures measured on 2026-10-24 against next (5a38bd1, engine 0b4eac5) on
// linux-x64. Each id names what has to land before the case can pass; the
// case still runs and still fails until then. Remove an entry in the change
// that fixes it.
//   engine-depth-guard: native SIGSEGV or Wasm RangeError on deep nesting.
//   runtime-error-model: a Wasm allocation failure or trap escapes as a raw
//     RuntimeError (ABORTING_MALLOC=1) instead of an AssimpError (PR-2).
//   engine-input-hardening: the engine crashes (SIGSEGV, SIGABRT from an
//     uncaught DeadlyImportError, a glibc double free), exhausts memory, or
//     hangs on a truncated or garbage file.
const KNOWN_FAILURES = {
  'deep/gltf-node-chain': ['engine-depth-guard'],
  'deep/gltf-json-arrays': ['engine-depth-guard'],
  'deep/fbx-ascii-scopes': ['engine-depth-guard'],
  'deep/collada-node-chain': ['engine-depth-guard'],
  'count/ply-binary-vertices': ['runtime-error-model'],
  'count/ply-ascii-faces': ['runtime-error-model'],
  // Native exceeds the worker memory limit on win32, where only the watchdog
  // enforces it (CI run 40061069486).
  'count/off-vertices': ['engine-input-hardening', 'runtime-error-model'],
  'truncated-half/cube-ascii.ply': ['engine-input-hardening'],
  'truncated-half/cube_binary.ply': ['engine-input-hardening', 'runtime-error-model'],
  'truncated-head/cube-blender-ifc4.ifc': ['engine-input-hardening', 'runtime-error-model'],
  'garbage/cube-blender-ifc4.ifc': ['engine-input-hardening', 'runtime-error-model'],
  'garbage/spherewithlight.ac': ['engine-input-hardening'],
  'truncated-head/threecubesgreen.ase': ['engine-input-hardening'],
  'garbage/threecubesgreen.ase': ['engine-input-hardening'],
  'truncated-half/molecule.cob': ['engine-input-hardening', 'runtime-error-model'],
  'truncated-head/molecule.cob': ['engine-input-hardening', 'runtime-error-model'],
  'truncated-half/simplecube.md5mesh': ['engine-input-hardening'],
  // Native crashes on win32 only (CI run 40061069486).
  'truncated-half/chrome_sphere.mdl': ['engine-input-hardening'],
  'garbage/chrome_sphere.mdl': ['engine-input-hardening', 'runtime-error-model'],
  'truncated-half/example.ogex': ['engine-input-hardening', 'runtime-error-model'],
  'garbage/example.ogex': ['engine-input-hardening', 'runtime-error-model'],
  'garbage/triangle.smd': ['engine-input-hardening'],
};

const BASE_CASES = [
  // Deep nesting. The engine depth guard (taucad/assimp libassimp-next, PR-1)
  // turns these into IMPORT_FAILED on both backends; until then native dies
  // with SIGSEGV or Wasm throws a raw RangeError, depending on the parser.
  {
    id: 'deep/gltf-node-chain',
    family: 'deep-nesting',
    generate: (scale) => {
      const depth = DEPTH[scale];
      const nodes = Array.from({ length: depth }, (_, index) =>
        index + 1 < depth ? { children: [index + 1] } : {},
      );
      return {
        files: [{ name: 'chain.gltf', bytes: gltf({ scene: 0, scenes: [{ nodes: [0] }], nodes }) }],
        to: 'glb',
      };
    },
  },
  {
    id: 'deep/gltf-json-arrays',
    family: 'deep-nesting',
    generate: (scale) => ({
      files: [
        {
          name: 'arrays.gltf',
          bytes: utf8(`{"asset":{"version":"2.0"},"extras":${deep('[', ']', DEPTH[scale])}}`),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'deep/fbx-ascii-scopes',
    family: 'deep-nesting',
    generate: (scale) => ({
      files: [
        {
          name: 'scopes.fbx',
          bytes: utf8(`${fbxAsciiHeader}Objects:  {\n${deep('A: {\n', '}\n', DEPTH[scale])}}\n`),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'deep/collada-node-chain',
    family: 'deep-nesting',
    generate: (scale) => ({
      files: [
        {
          name: 'chain.dae',
          bytes: utf8(
            `${colladaOpen}<library_visual_scenes><visual_scene id="s">${deep('<node>', '</node>', DEPTH[scale])}</visual_scene></library_visual_scenes>\n<scene><instance_visual_scene url="#s"/></scene>\n</COLLADA>\n`,
          ),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'deep/usda-prim-chain',
    family: 'deep-nesting',
    generate: (scale) => ({
      files: [
        { name: 'chain.usda', bytes: utf8(`#usda 1.0\n${deep('def Xform "n" {\n', '}\n', DEPTH[scale])}`) },
      ],
      to: 'glb',
    }),
  },

  // Archive bombs: a small archive whose entry inflates to BOMB bytes.
  {
    id: 'zip-bomb/usdz',
    family: 'zip-bomb',
    generate: (scale) => ({
      files: [
        {
          name: 'bomb.usdz',
          bytes: zip([{ name: 'bomb.usda', deflated: deflatedZeros(utf8('#usda 1.0\n'), BOMB[scale]) }]),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'zip-bomb/usdz-size-lie',
    family: 'zip-bomb',
    generate: (scale) => ({
      files: [
        {
          name: 'lie.usdz',
          bytes: zip([
            { name: 'lie.usda', deflated: deflatedZeros(utf8('#usda 1.0\n'), BOMB[scale]), declaredSize: 16 },
          ]),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'zip-bomb/3mf',
    family: 'zip-bomb',
    generate: (scale) => ({
      files: [
        {
          name: 'bomb.3mf',
          bytes: zip([
            {
              name: '[Content_Types].xml',
              bytes: utf8(
                '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
              ),
            },
            {
              name: '_rels/.rels',
              bytes: utf8(
                '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
              ),
            },
            {
              name: '3D/3dmodel.model',
              deflated: deflatedZeros(
                utf8('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" '),
                BOMB[scale],
              ),
            },
          ]),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'zip-bomb/zae',
    family: 'zip-bomb',
    generate: (scale) => ({
      files: [
        {
          name: 'bomb.zae',
          bytes: zip([
            {
              name: 'manifest.xml',
              bytes: utf8('<?xml version="1.0" encoding="utf-8"?><dae_root>scene.dae</dae_root>'),
            },
            { name: 'scene.dae', deflated: deflatedZeros(utf8(colladaOpen), BOMB[scale]) },
          ]),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'zip-bomb/pk3',
    family: 'zip-bomb',
    generate: (scale) => ({
      files: [
        {
          name: 'bomb.pk3',
          bytes: zip([
            { name: 'maps/bomb.bsp', deflated: deflatedZeros(utf8('IBSP.\u0000\u0000\u0000'), BOMB[scale]) },
          ]),
        },
      ],
      to: 'glb',
    }),
  },

  // Oversized counts: headers that declare far more data than the file holds.
  {
    id: 'count/ply-binary-vertices',
    family: 'oversized-count',
    generate: () => ({
      files: [
        {
          name: 'count.ply',
          bytes: concat([
            utf8(
              'ply\nformat binary_little_endian 1.0\nelement vertex 4294967295\nproperty float x\nproperty float y\nproperty float z\nend_header\n',
            ),
            new Uint8Array(12),
          ]),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'count/ply-ascii-faces',
    family: 'oversized-count',
    generate: () => ({
      files: [
        {
          name: 'faces.ply',
          bytes: utf8(
            'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 2147483647\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
          ),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'count/stl-binary-triangles',
    family: 'oversized-count',
    generate: () => {
      const bytes = new Uint8Array(84 + 50);
      new DataView(bytes.buffer).setUint32(80, 0xffff_ffff, true);
      return { files: [{ name: 'count.stl', bytes }], to: 'glb' };
    },
  },
  {
    id: 'count/gltf-accessor',
    family: 'oversized-count',
    generate: () => ({
      files: [
        {
          name: 'accessor.gltf',
          bytes: gltf({
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            buffers: [{ byteLength: 12, uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAA' }],
            bufferViews: [{ buffer: 0, byteLength: 12 }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 2_147_483_647, type: 'VEC3' }],
          }),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'count/collada-float-array',
    family: 'oversized-count',
    generate: () => ({
      files: [
        {
          name: 'count.dae',
          bytes: utf8(
            `${colladaOpen}<library_geometries><geometry id="g"><mesh><source id="p"><float_array id="pa" count="2147483647">0 0 0</float_array><technique_common><accessor source="#pa" count="715827882" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="715827882"><input semantic="VERTEX" source="#v" offset="0"/><p>0 0 0</p></triangles></mesh></geometry></library_geometries>\n</COLLADA>\n`,
          ),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'count/obj-index',
    family: 'oversized-count',
    generate: () => ({
      files: [{ name: 'index.obj', bytes: utf8('v 0 0 0\nv 1 0 0\nf 1 2 2147483647\n') }],
      to: 'glb',
    }),
  },
  {
    id: 'count/off-vertices',
    family: 'oversized-count',
    generate: () => ({
      files: [{ name: 'count.off', bytes: utf8('OFF\n2147483647 1 0\n0 0 0\n3 0 1 2\n') }],
      to: 'glb',
    }),
  },

  // base64: a declared length far past the payload, and a large payload.
  {
    id: 'base64/gltf-declared-length',
    family: 'base64',
    generate: () => ({
      files: [
        {
          name: 'declared.gltf',
          bytes: gltf({
            buffers: [{ byteLength: 4_294_967_295, uri: 'data:application/octet-stream;base64,AAAA' }],
            bufferViews: [{ buffer: 0, byteLength: 4_294_967_295 }],
          }),
        },
      ],
      to: 'glb',
    }),
  },
  {
    id: 'base64/gltf-large-payload',
    family: 'base64',
    generate: (scale) => {
      const length = BASE64[scale];
      const prefix = utf8(
        `{"asset":{"version":"2.0"},"buffers":[{"byteLength":${(length / 4) * 3},"uri":"data:application/octet-stream;base64,`,
      );
      const payload = new Uint8Array(length).fill('A'.codePointAt(0));
      return { files: [{ name: 'payload.gltf', bytes: concat([prefix, payload, utf8('"}]}')]) }], to: 'glb' };
    },
  },

  // zlib: FBX binary arrays are zlib streams whose declared length the
  // reader trusts to size its output.
  {
    id: 'zlib/fbx-array-bomb',
    family: 'zlib-bomb',
    generate: (scale) => {
      // Whole vertices (3 doubles each), so only the size can make it fail.
      const doubles = Math.floor(BOMB[scale] / 24) * 3;
      return {
        files: [{ name: 'bomb.fbx', bytes: fbxBinary(fbxDoubleArray(doubles, zlibZeros(doubles * 8))) }],
        to: 'glb',
      };
    },
  },
  {
    id: 'zlib/fbx-array-length-lie',
    family: 'zlib-bomb',
    generate: (scale) => ({
      files: [{ name: 'lie.fbx', bytes: fbxBinary(fbxDoubleArray(3, zlibZeros(BOMB[scale]))) }],
      to: 'glb',
    }),
  },

  ...truncationCases,
];

export const CASES = BASE_CASES.map((testCase) => ({
  ...testCase,
  needs: KNOWN_FAILURES[testCase.id] ?? [],
}));
