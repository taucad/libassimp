// SPIKE: per-tier geomeans and per-cell medians against the system allocator.
//   node spike/summary.mjs <base> <variant>...
import { existsSync, readFileSync } from 'node:fs';
const load = (v) => existsSync(`results/${v}.jsonl`) ? readFileSync(`results/${v}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : null; };
const agg = (rows) => {
  const m = {}; for (const r of rows) (m[r.cell] ??= []).push(r);
  const o = {};
  for (const [k, rs] of Object.entries(m)) {
    const ok = rs.filter((r) => !r.error);
    o[k] = { size: rs[0].size, n: ok.length, errors: rs.length - ok.length, error: rs.find((r) => r.error)?.error,
      ms: med(ok.map((r) => r.ms)), cpu: med(ok.map((r) => r.cpuMs)), rss: med(ok.map((r) => r.maxRssMB)), sha: ok[0]?.outSha };
  }
  return o;
};
const gm = (xs) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const p = (x) => ((x - 1) * 100).toFixed(1).padStart(6) + '%';
const [baseName, ...vs] = process.argv.slice(2);
const base = agg(load(baseName));
const lines = [];
for (const v of vs) {
  const a = agg(load(v));
  const ks = Object.keys(a).filter((k) => a[k].ms && base[k]?.ms);
  const errs = Object.entries(a).filter(([, c]) => c.errors);
  lines.push(`## ${v} vs ${baseName}: cells ${ks.length}, outputs differ ${ks.filter((k) => a[k].sha !== base[k].sha).length}, cells with errors ${errs.length}`);
  for (const [k, c] of errs.slice(0, 5)) lines.push(`  ERROR ${k} x${c.errors}: ${c.error}`);
  for (const sz of ['S', 'M', 'L', 'R']) {
    const t = ks.filter((k) => a[k].size === sz);
    if (!t.length) continue;
    const r = t.map((k) => a[k].ms / base[k].ms);
    lines.push(`  ${sz}(n=${t.length}) wall${p(gm(r))} [${p(Math.min(...r))}..${p(Math.max(...r))}] cpu${p(gm(t.map((k) => a[k].cpu / base[k].cpu)))} rss${p(gm(t.map((k) => a[k].rss / base[k].rss)))}`);
  }
  for (const k of ks) lines.push(`    ${k.padEnd(24)} ${base[k].ms.toFixed(0).padStart(7)} -> ${a[k].ms.toFixed(0).padStart(7)} ms ${p(a[k].ms / base[k].ms)}  rss ${base[k].rss.toFixed(0)} -> ${a[k].rss.toFixed(0)} MB`);
}
console.log(lines.join('\n'));
