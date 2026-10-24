// SPIKE: interleaved native allocator benchmark.
//   node spike/drive.mjs <reps> <variant>...   (addons at addons/<variant>/libassimp.node)
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [repsArg, ...wanted] = process.argv.slice(2);
const variants = wanted.filter((v) => existsSync(resolve('addons', v, 'libassimp.node')));
console.log('variants', variants, 'missing', wanted.filter((v) => !variants.includes(v)));
const M = resolve('models');
const cells = [];
for (const [size, side] of [['S', 64], ['M', 256], ['L', 1024]]) {
  for (const [from, to] of [['obj', 'glb'], ['glb', 'glb'], ['ply', 'glb'], ['stl', 'glb'], ['glb', 'usdz'], ['usdz', 'glb'], ['glb', 'obj'], ['glb', 'stl']]) {
    cells.push({ id: `grid${side}.${from}-${to}`, size, input: `${M}/grid${side}.${from}`, to });
  }
}
for (const [file, to] of [['gear.glb', 'glb'], ['gear.glb', 'usdz'], ['gear.glb', 'obj'], ['gear.glb', 'stl'], ['helmet.glb', 'glb'], ['helmet.glb', 'usdz'], ['helmet.usdz', 'glb']]) {
  cells.push({ id: `${file.replace('.', '-')}-${to}`, size: 'R', input: `${M}/${file}`, to });
}
mkdirSync('results', { recursive: true });
for (let rep = 0; rep < Number(repsArg); rep++) {
  cells.forEach((cell, index) => {
    for (let k = 0; k < variants.length; k++) {
      const variant = variants[(k + rep + index) % variants.length];
      const env = { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: resolve('addons', variant, 'libassimp.node') };
      const r = spawnSync(process.execPath, ['--max-old-space-size=6000', resolve('spike/run.mjs'), resolve('dist'), 'native', cell.input, cell.to],
        { encoding: 'utf8', env, timeout: 900_000 });
      const line = (r.stdout || '').trim().split('\n').pop() || '';
      let j;
      try { j = JSON.parse(line); } catch { j = { error: `exit ${r.status} ${r.signal ?? ''} ${(r.stderr || r.stdout || '').slice(-400).replace(/\s+/g, ' ')}` }; }
      appendFileSync(`results/${variant}.jsonl`, JSON.stringify({ variant, backend: 'native', cell: cell.id, size: cell.size, rep, ...j }) + '\n');
      console.log(`${variant} ${cell.id} r${rep} ` + (j.error ? `ERROR ${j.error}` : `${Math.round(j.ms)}ms cpu${Math.round(j.cpuMs)} rss=${j.maxRssMB.toFixed(0)} sha=${j.outSha}`));
    }
  });
}
