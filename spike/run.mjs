// One conversion per child process; prints one JSON line.
//   node run.mjs <distDir> <backend> <inputPath> <to> [dumpPath]
// For the native backend set NAPI_RS_NATIVE_LIBRARY_PATH to the variant's libassimp.node.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [distDir, backend, input, to, dump] = process.argv.slice(2);
const entry = await import(pathToFileURL(`${distDir}/index.node.mjs`).href);
const bytes = new Uint8Array(readFileSync(input));
const tc = performance.now();
const assimp = await entry.createAssimp({ backend });
const createMs = performance.now() - tc;
if (assimp.backend !== backend) throw new Error(`asked for ${backend}, got ${assimp.backend}`);
const memKey = Symbol.for('libassimp.memoryBytes');
const mem0 = assimp[memKey]?.();
const rss0 = process.memoryUsage().rss;
const maxRss0 = process.resourceUsage().maxRSS;
const cpu0 = process.cpuUsage();
const t0 = performance.now();
let out;
try {
  out = await assimp.convert({ name: basename(input), bytes }, { to });
} catch (error) {
  console.log(JSON.stringify({ error: `${error.code ?? ''} ${String(error.message).slice(0, 300)}`,
    wasmMB: assimp[memKey]?.() / 1048576, maxRssMB: process.resourceUsage().maxRSS / 1024,
    ms: performance.now() - t0 }));
  process.exit(0);
}
const ms = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
const mem1 = assimp[memKey]?.();
const primary = out.files[0].bytes;
let verts = null;
if (to === 'glb') {
  const dv = new DataView(primary.buffer, primary.byteOffset, primary.byteLength);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(primary.subarray(20, 20 + jl)));
  verts = 0;
  for (const m of json.meshes ?? []) for (const p of m.primitives) verts += json.accessors[p.attributes.POSITION].count;
}
const sha = createHash('sha1'); for (const f of out.files) sha.update(f.bytes);
const outSha = sha.digest('hex').slice(0, 16);
if (dump) for (const f of out.files) writeFileSync(f === out.files[0] ? dump : `${dump}.${f.name}`, f.bytes);
console.log(JSON.stringify({
  ms, cpuMs: (cpu.user + cpu.system) / 1000, createMs,
  outSha, outBytes: out.files.reduce((s, f) => s + f.bytes.length, 0), files: out.files.length, verts,
  wasmMB: mem1 === undefined ? null : mem1 / 1048576, wasmMB0: mem0 === undefined ? null : mem0 / 1048576,
  maxRssMB: process.resourceUsage().maxRSS / 1024, maxRss0MB: maxRss0 / 1024, rss0MB: rss0 / 1048576,
}));
process.exit(0);
