#!/usr/bin/env node
// Feed every hostile input in adversarial-cases.mjs to both backends and
// require the same classification from each: either both convert, or both
// reject with an AssimpError carrying the same code. A crash, a hang or an
// untyped error fails the case.
//
// Cases run in worker processes, one backend at a time, so a native SIGSEGV is
// recorded against the case that caused it instead of ending the run. A
// failing case that names `needs` reports the workstream it waits on; it still
// fails the run.
//
//   node tests/adversarial-parity.mjs                  every case, both backends
//   LIBASSIMP_ADVERSARIAL_FILTER=zip-bomb node ...     only ids containing the text
//   LIBASSIMP_ADVERSARIAL_BACKENDS=wasm node ...       one backend (no parity check)
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CASES } from './adversarial-cases.mjs';

// Origin: the slowest passing case (the 1 GiB ZAE bomb) took 4.9 s native and
// 4.5 s Wasm on the local 4-vCPU linux-x64 host; 60 s leaves about 12x for
// slower runners. The hanging AC and SMD inputs were still running at 400 s.
const CASE_TIMEOUT_MS = 60_000;
const NEEDS = {
  'engine-depth-guard': 'the engine depth guard (taucad/assimp libassimp-next, PR-1)',
  'runtime-error-model': 'ABORTING_MALLOC=0 and ENGINE_FAILED wrapping (PR-2)',
  'engine-input-hardening': 'an engine fix for truncated or garbage input',
};
const waitsOn = ({ needs }) => needs.map((need) => NEEDS[need] ?? need).join(' and ');

const filter = process.env.LIBASSIMP_ADVERSARIAL_FILTER ?? '';
const selected = CASES.filter(({ id }) => id.includes(filter));
const self = fileURLToPath(import.meta.url);

const describeError = async (error, entry) => {
  const { AssimpError } = await import(entry);
  return {
    outcome: 'error',
    typed: error instanceof AssimpError,
    name: error?.name ?? typeof error,
    code: error?.code,
    message: String(error?.message ?? error).slice(0, 160),
  };
};

// A runaway native allocation (garbage MDL) took the whole 16 GB CI runner
// down with it. The worker stops itself above this resident size and the case
// records `memory-limit`. Origin: the heaviest passing case, the 1 GiB ZAE
// bomb, peaked at 3.1 GiB on both backends locally (generator included);
// 5 GiB keeps 1.9 GiB of headroom and still fits the 7 GB macOS runners.
const RSS_LIMIT_BYTES = 5 * 1024 ** 3;

// The watchdog samples, and on the Linux runner a garbage MDL still outgrew the
// machine between samples and took the runner down. On Linux the kernel
// enforces the same limit instead: RLIMIT_DATA counts the private writable
// memory both backends allocate (V8's PROT_NONE reservations are not counted),
// so an oversized allocation fails inside the worker, which is the OS memory
// limit SECURITY.md tells native users to set.
const hasPrlimit = (() => {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('prlimit', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const workerCommand = (args) =>
  hasPrlimit
    ? ['prlimit', [`--data=${RSS_LIMIT_BYTES}`, '--', process.execPath, ...args]]
    : [process.execPath, args];

const worker = async (backend, start) => {
  let current = start;
  // Native conversions run off the main thread, so this timer keeps firing
  // while the engine allocates. Wasm is capped by its own 4 GB heap.
  setInterval(() => {
    if (process.memoryUsage.rss() <= RSS_LIMIT_BYTES) return;
    process.stdout.write(`RESULT ${current} ${JSON.stringify({ outcome: 'memory-limit' })}\n`, () =>
      process.exit(70),
    );
  }, 50).unref();
  const entry = new URL(
    backend === 'native' ? '../dist/index.node.mjs' : '../dist/index.mjs',
    import.meta.url,
  ).href;
  const { createAssimp } = await import(entry);
  for (let index = start; index < selected.length; index += 1) {
    current = index;
    process.stdout.write(`START ${index}\n`);
    const { files, to } = selected[index].generate('full');
    let result;
    const assimp = await createAssimp({ backend });
    const started = performance.now();
    try {
      await assimp.convert(files.length === 1 ? files[0] : files, { to });
      result = { outcome: 'ok' };
    } catch (error) {
      result = await describeError(error, entry);
    } finally {
      assimp.dispose();
    }
    result.ms = Math.round(performance.now() - started);
    // The worker's high-water mark so far (maxRSS is in KiB).
    result.peakMiB = Math.round(process.resourceUsage().maxRSS / 1024);
    process.stdout.write(`RESULT ${index} ${JSON.stringify(result)}\n`);
  }
};

const runBackend = (backend) =>
  new Promise((resolve) => {
    const results = Array.from({ length: selected.length });
    const launch = (start) => {
      if (start >= selected.length) return resolve(results);
      const args = [self, '--worker', backend, String(start)];
      const child = spawn(...workerCommand(args), { stdio: ['ignore', 'pipe', 'inherit'] });
      let current = start;
      let timer;
      let buffer = '';
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          results[current] = { outcome: 'timeout' };
          child.kill('SIGKILL');
        }, CASE_TIMEOUT_MS);
      };
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const [kind, index, ...rest] = line.split(' ');
          if (kind === 'START') {
            current = Number(index);
            arm();
          } else if (kind === 'RESULT') {
            results[Number(index)] = JSON.parse(rest.join(' '));
          }
        }
      });
      child.on('exit', (status, signal) => {
        clearTimeout(timer);
        if (results[current] === undefined) results[current] = { outcome: 'crash', status, signal };
        if (status === 0 && results.slice(start).every((result) => result !== undefined))
          return resolve(results);
        launch(current + 1);
      });
    };
    launch(0);
  });

const label = (result) =>
  result === undefined
    ? 'missing'
    : result.outcome === 'error'
      ? `${result.typed ? 'AssimpError' : `untyped ${result.name}`}(${result.code ?? '-'})`
      : result.outcome === 'crash'
        ? `crash(${result.signal ?? result.status})`
        : result.outcome;

const acceptable = (result) => result?.outcome === 'ok' || (result?.outcome === 'error' && result.typed);

const main = async () => {
  const backends = (process.env.LIBASSIMP_ADVERSARIAL_BACKENDS ?? 'native,wasm').split(',');
  const started = Date.now();
  const byBackend = {};
  for (const backend of backends) byBackend[backend] = await runBackend(backend);
  const rows = selected.map((testCase, index) => {
    const results = backends.map((backend) => byBackend[backend][index]);
    const problems = [];
    results.forEach((result, position) => {
      if (!acceptable(result)) problems.push(`${backends[position]} ${label(result)}`);
    });
    if (
      results.length === 2 &&
      results.every(acceptable) &&
      (results[0].outcome !== results[1].outcome || results[0].code !== results[1].code)
    ) {
      problems.push(`backends disagree: ${results.map(label).join(' vs ')}`);
    }
    return { testCase, results, problems };
  });

  const lines = [
    `| case | ${backends.join(' | ')} | verdict |`,
    `| --- | ${backends.map(() => '---').join(' | ')} | --- |`,
    ...rows.map(({ testCase, results, problems }) => {
      const verdict =
        problems.length === 0
          ? 'pass'
          : `FAIL: ${problems.join('; ')}${testCase.needs.length > 0 ? ` (waits on ${waitsOn(testCase)})` : ''}`;
      return `| ${testCase.id} | ${results.map(label).join(' | ')} | ${verdict} |`;
    }),
  ];
  const failures = rows.filter(({ problems }) => problems.length > 0);
  // A listed case that passes should leave KNOWN_FAILURES. Memory-safety
  // failures differ by platform (glibc reports a double free that macOS may
  // not), so this warns instead of failing.
  const fixed = rows.filter(({ testCase, problems }) => problems.length === 0 && testCase.needs.length > 0);
  for (const { testCase } of fixed) {
    process.stdout.write(
      `::warning title=adversarial ${testCase.id}::passes here; remove it from KNOWN_FAILURES once it passes on every target.\n`,
    );
  }
  const summary = `${selected.length - failures.length}/${selected.length} adversarial cases pass on ${backends.join(' and ')} in ${Math.round((Date.now() - started) / 1000)} s`;
  process.stdout.write(`${lines.join('\n')}\n\n${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Adversarial inputs\n\n${summary}\n\n${lines.join('\n')}\n`,
    );
  }
  for (const { testCase, problems } of failures) {
    const waiting = testCase.needs.length > 0 ? ` Waits on ${waitsOn(testCase)}.` : ' New failure.';
    process.stdout.write(`::error title=adversarial ${testCase.id}::${problems.join('; ')}.${waiting}\n`);
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
};

if (process.argv[2] === '--worker') {
  await worker(process.argv[3], Number(process.argv[4]));
} else {
  await main();
}
