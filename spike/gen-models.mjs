// Generate grid models (indexed) in OBJ, binary STL, binary PLY and GLB.
//   node gen-models.mjs <outdir> <side>...
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
const [out, ...sides] = process.argv.slice(2);
const z = (x, y) => Math.sin(x * 0.1) * Math.cos(y * 0.1);
const want = (f) => !process.env.FORMATS || process.env.FORMATS.split(',').includes(f);
for (const side of sides.map(Number)) {
  // OBJ: quads, v/vt/vn indexed identically (same as the audit harness)
  if (want('obj'))
  {
    const fd = openSync(`${out}/grid${side}.obj`, 'w');
    let parts = ['# grid\n'];
    const flush = () => { writeSync(fd, parts.join('')); parts = []; };
    for (let y = 0; y < side; y++) { for (let x = 0; x < side; x++) parts.push(`v ${x} ${y} ${z(x, y)}\n`); flush(); }
    for (let y = 0; y < side; y++) { for (let x = 0; x < side; x++) parts.push(`vn 0 0 1\nvt ${(x / side).toFixed(4)} ${(y / side).toFixed(4)}\n`); flush(); }
    for (let y = 0; y < side - 1; y++) { for (let x = 0; x < side - 1; x++) { const a = y * side + x + 1, b = a + 1, c = a + side, d = c + 1; parts.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${d}/${d}/${d} ${c}/${c}/${c}\n`); } flush(); }
    closeSync(fd);
  }
  // binary STL: un-indexed triangles
  if (want('stl'))
  {
    const tris = 2 * (side - 1) * (side - 1);
    const buf = Buffer.alloc(84 + tris * 50);
    buf.writeUInt32LE(tris, 80);
    let o = 84;
    const put = (x, y) => { buf.writeFloatLE(x, o); buf.writeFloatLE(y, o + 4); buf.writeFloatLE(z(x, y), o + 8); o += 12; };
    for (let y = 0; y < side - 1; y++) for (let x = 0; x < side - 1; x++) {
      for (const t of [[[x, y], [x + 1, y], [x + 1, y + 1]], [[x, y], [x + 1, y + 1], [x, y + 1]]]) {
        buf.writeFloatLE(0, o); buf.writeFloatLE(0, o + 4); buf.writeFloatLE(1, o + 8); o += 12;
        for (const [px, py] of t) put(px, py);
        o += 2;
      }
    }
    writeFileSync(`${out}/grid${side}.stl`, buf);
  }
  // binary PLY: indexed triangles, positions only
  if (want('ply'))
  {
    const verts = side * side, faces = 2 * (side - 1) * (side - 1);
    const header = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${verts}\nproperty float x\nproperty float y\nproperty float z\nelement face ${faces}\nproperty list uchar uint vertex_indices\nend_header\n`);
    const body = Buffer.alloc(verts * 12 + faces * 13);
    let o = 0;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { body.writeFloatLE(x, o); body.writeFloatLE(y, o + 4); body.writeFloatLE(z(x, y), o + 8); o += 12; }
    for (let y = 0; y < side - 1; y++) for (let x = 0; x < side - 1; x++) {
      const a = y * side + x, b = a + 1, c = a + side, d = c + 1;
      for (const t of [[a, b, d], [a, d, c]]) { body.writeUInt8(3, o); body.writeUInt32LE(t[0], o + 1); body.writeUInt32LE(t[1], o + 5); body.writeUInt32LE(t[2], o + 9); o += 13; }
    }
    writeFileSync(`${out}/grid${side}.ply`, Buffer.concat([header, body]));
  }
  // GLB: indexed, POSITION + NORMAL + TEXCOORD_0, uint32 indices
  if (want('glb'))
  {
    const n = side * side, tris = 2 * (side - 1) * (side - 1);
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array(tris * 3);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const i = y * side + x; const p = [x, y, Math.fround(z(x, y))];
      pos.set(p, i * 3); nrm.set([0, 0, 1], i * 3); uv.set([x / side, 1 - y / side], i * 2);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    }
    let t = 0;
    for (let y = 0; y < side - 1; y++) for (let x = 0; x < side - 1; x++) { const a = y * side + x, b = a + 1, c = a + side, d = c + 1; idx.set([a, b, d, a, d, c], t); t += 6; }
    const views = [pos, nrm, uv, idx].map((a) => Buffer.from(a.buffer));
    let off = 0; const bufferViews = views.map((v, i) => { const bv = { buffer: 0, byteOffset: off, byteLength: v.length, target: i === 3 ? 34963 : 34962 }; off += v.length; return bv; });
    const json = {
      asset: { version: '2.0', generator: 'spike-grid' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'grid' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
      materials: [{ name: 'grey', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max },
        { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: n, type: 'VEC2' },
        { bufferView: 3, componentType: 5125, count: tris * 3, type: 'SCALAR' },
      ],
      bufferViews, buffers: [{ byteLength: off }],
    };
    let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(views);
    const hdr = Buffer.alloc(12); hdr.writeUInt32LE(0x46546c67, 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    writeFileSync(`${out}/grid${side}.glb`, Buffer.concat([hdr, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
  }
  console.log('generated', side);
}
