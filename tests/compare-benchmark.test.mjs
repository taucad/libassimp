import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { averageBenchmarks, compareBenchmark } from '../scripts/compare-benchmark.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const benchmark = fileURLToPath(new URL('../bench/gated.mjs', import.meta.url));

const runResolverBenchmark = (backend) => {
  const work = mkdtempSync(join(tmpdir(), 'libassimp-benchmark-'));
  const entry = join(work, 'entry.mjs');
  writeFileSync(
    entry,
    `const encoder = new TextEncoder();
const decoder = new TextDecoder();
const run = async (files, options) => {
  const input = Array.isArray(files) ? files[0] : files;
  const names = [...decoder.decode(input.bytes).matchAll(/^mtllib (.+)$/gmu)].map((match) => match[1]);
  for (const name of names) await options.resolve?.(name);
  const to = options.to;
  return { files: [{ name: \`result.\${to}\`, bytes: encoder.encode(\`\${to}:\${names.join(',')}\`) }] };
};
export const createAssimp = async ({ backend = 'wasm' } = {}) => ({
  backend,
  convert: run,
  convertFormats: async (files, { targets, ...options }) =>
    Promise.all(targets.map(async ({ to, exportOptions }) => ({
      format: to,
      ...(await run(files, { ...options, to, exportOptions })),
    }))),
  dispose() {},
});
export const convert = run;
`,
  );
  try {
    return JSON.parse(
      execFileSync(process.execPath, [benchmark], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          LIBASSIMP_BENCH_BACKEND: backend,
          LIBASSIMP_BENCH_ENTRY: entry,
          MAX_INIT_MS: '1000',
          MAX_MEDIAN_MS: '1000',
        },
      }),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const report = (medianMs, initMs = 20) => ({
  name: 'helical-gear-glb-to-glb-v1',
  medianMs,
  initMs,
  outputBytes: 2_360,
  outputFnv: '8d006812b6e519d6',
});

describe('benchmark comparison', () => {
  it('averages balanced same-runner samples before applying the unchanged gate', () => {
    const current = averageBenchmarks([report(1.4, 44), report(1, 40)]);
    const base = averageBenchmarks([report(1.3, 42), report(1.1, 38)]);
    expect(current).toMatchObject({ medianMs: 1.2, initMs: 42 });
    expect(compareBenchmark(current, base).failed).toBe(false);
  });

  it('refuses to average different output fingerprints', () => {
    expect(() => averageBenchmarks([report(1), { ...report(1), outputFnv: 'different' }])).toThrow(
      'different identities or output fingerprints',
    );
  });

  it('reports deterministic dependency-heavy native, JSPI, and replay evidence', () => {
    const native = runResolverBenchmark('native').dependencyResolver;
    const wasm = runResolverBenchmark('wasm').dependencyResolver;
    const observable = ({ sidecars, resolverCalls, outputBytes, outputFnv }) => ({
      sidecars,
      resolverCalls,
      outputBytes,
      outputFnv,
    });

    expect(native.sidecars).toEqual([1, 8, 32]);
    expect(native.replayWorstCaseImports).toEqual([2, 9, 33]);
    expect(native.routes.native.map(({ resolverCalls }) => resolverCalls)).toEqual(native.sidecars);
    expect(wasm.routes.replay.map(({ resolverCalls }) => resolverCalls)).toEqual(wasm.sidecars);
    expect(wasm.routes.replay.map(observable)).toEqual(native.routes.native.map(observable));
    if (wasm.routes.jspi !== null) {
      expect(wasm.routes.jspi.map(observable)).toEqual(native.routes.native.map(observable));
    }
  });

  it('fails closed when an implementation PR skips the benchmark', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const checker = readFileSync(new URL('../scripts/check-workflows.sh', import.meta.url), 'utf8');
    const policy = "if (needs.preflight.outputs.kind === 'pull-request') required.push('benchmark');";

    expect(workflow).toContain("if: github.event_name == 'pull_request'");
    expect(workflow).toContain(policy);
    expect(checker).toContain(policy);
  });
});
