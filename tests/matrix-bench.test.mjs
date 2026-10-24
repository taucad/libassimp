import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { GENERATED, writeGenerated } from '../bench/matrix-inputs.mjs';
import { compareCell, mergeReports, renderMarkdown } from '../bench/matrix-report.mjs';

const matrix = fileURLToPath(new URL('../bench/matrix.mjs', import.meta.url));
const reporter = fileURLToPath(new URL('../bench/matrix-report.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'libassimp-matrix-'));
afterAll(() => rmSync(work, { force: true, recursive: true }));

// A stand-in entry: `boom` kills the process, `bad` rejects like an AssimpError,
// and the `pr` flavour writes different STL bytes and crashes on `boom` only.
const fakeEntry = (flavour) => {
  const path = join(work, `${flavour}.mjs`);
  writeFileSync(
    path,
    `const flavour = ${JSON.stringify(flavour)};
class AssimpError extends Error { constructor(code, message) { super(message); this.name = 'AssimpError'; this.code = code; } }
export const createAssimp = async ({ backend }) => ({
  backend,
  formats: { import: [{ id: 'obj' }], export: ['glb', 'stl', 'bad', 'boom'].map((id) => ({ id })) },
  async convert(input, { to }) {
    const files = Array.isArray(input) ? input : [input];
    if (to === 'boom' && flavour === 'pr') process.exit(7);
    if (to === 'bad') throw new AssimpError('EXPORT_FAILED', 'no');
    const tag = to === 'stl' ? flavour : 'same';
    return { files: [{ name: 'result.' + to, bytes: new TextEncoder().encode(tag + files.map((f) => f.bytes.length).join()) }] };
  },
  [Symbol.for('libassimp.memoryBytes')]: () => (backend === 'wasm' ? 65536 : undefined),
  dispose() {},
});
`,
  );
  return path;
};

const run = (args) => {
  const child = spawnSync(process.execPath, [matrix, ...args], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  return child;
};

describe('bench/matrix.mjs', () => {
  const models = join(work, 'models');
  mkdirSync(join(models, 'OBJ'), { recursive: true });
  writeFileSync(join(models, 'OBJ/cube_usemtl.obj'), 'v 0 0 0\n');
  writeFileSync(join(models, 'OBJ/cube_usemtl.mtl'), 'newmtl a\n');
  const base = fakeEntry('base');
  const pr = fakeEntry('pr');

  it('measures every export target per fixture for each build and contains a crash to its cell', () => {
    const out = join(work, 'small.json');
    run([
      '--backend',
      'wasm',
      '--tier',
      'small',
      '--runs',
      '2',
      '--models',
      models,
      '--filter',
      '^OBJ ',
      '--build',
      `base=${base},rev=abc`,
      '--build',
      `pr=${pr}`,
      '--out',
      out,
    ]);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report).toMatchObject({
      schema: 'libassimp-format-matrix-v1',
      tier: 'small',
      backend: 'wasm',
      runs: 2,
    });
    expect(report.builds.base).toMatchObject({ rev: 'abc', exports: ['glb', 'stl', 'bad', 'boom'] });
    expect(report.builds.pr.calibration.samples).toHaveLength(30);
    const cells = Object.fromEntries(report.cells.map(({ id, results }) => [id, results]));
    expect(Object.keys(cells)).toEqual(['OBJ -> bad', 'OBJ -> boom', 'OBJ -> glb', 'OBJ -> stl']);
    expect(cells['OBJ -> glb'].base).toMatchObject({
      status: 'ok',
      runs: 2,
      outputFiles: 1,
      wasmHeapBytes: 65536,
      stable: true,
      inputBytes: 17,
    });
    expect(cells['OBJ -> glb'].base.sha256).toBe(cells['OBJ -> glb'].pr.sha256);
    expect(cells['OBJ -> stl'].base.sha256).not.toBe(cells['OBJ -> stl'].pr.sha256);
    expect(cells['OBJ -> bad'].pr).toMatchObject({ status: 'rejected', code: 'EXPORT_FAILED' });
    expect(cells['OBJ -> boom'].base.status).toBe('ok');
    expect(cells['OBJ -> boom'].pr).toMatchObject({
      status: 'crash',
      message: expect.stringContaining('exit 7'),
    });
    // The cells after the crash still ran in a fresh child.
    expect(cells['OBJ -> glb'].pr.status).toBe('ok');

    const markdown = join(work, 'small.md');
    const gate = spawnSync(process.execPath, [reporter, '--fail-on-crash', '--markdown', markdown, out], {
      encoding: 'utf8',
    });
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('wasm small: OBJ -> boom');
    const text = readFileSync(markdown, 'utf8');
    expect(text).toMatch(/^<!-- libassimp-format-matrix -->/u);
    expect(text).toContain('**New crashes:** OBJ -> boom');
    expect(text).toContain('| OBJ -> stl |');
    expect(spawnSync(process.execPath, [reporter, '--markdown', markdown, out]).status).toBe(0);
  });

  it('generates, derives and measures the large inputs once per side', () => {
    const inputs = join(work, 'inputs');
    const out = join(work, 'large.json');
    run([
      '--backend',
      'native',
      '--tier',
      'large',
      '--side',
      '4',
      '--runs',
      '1',
      '--inputs',
      inputs,
      '--filter',
      '^grid',
      '--build',
      `base=${base}`,
      '--out',
      out,
    ]);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report.side).toBe(4);
    expect(report.inputs.derivedBy).toMatchObject({
      'grid.dae': 'base (native)',
      'grid.usdz': 'base (native)',
    });
    expect(report.cells.map(({ id }) => id)).toEqual([
      'grid4.obj -> glb',
      'grid4.ply -> glb',
      'grid4.stl -> glb',
      'grid4.glb -> glb',
      'grid4.gltf -> glb',
      'grid4.usda -> glb',
      'grid4.dae -> glb',
      'grid4.fbx -> glb',
      'grid4.usdc -> glb',
      'grid4.usdz -> glb',
      'grid4.glb -> stl',
    ]);
    expect(report.cells[0].results.base).toMatchObject({ status: 'ok', wasmHeapBytes: null });
    const manifest = readFileSync(join(inputs, 'manifest.json'), 'utf8');
    run([
      '--backend',
      'native',
      '--tier',
      'large',
      '--side',
      '4',
      '--runs',
      '1',
      '--inputs',
      inputs,
      '--filter',
      'gear -> glb',
      '--shard',
      '1/1',
      '--build',
      `base=${base}`,
      '--out',
      out,
    ]);
    expect(readFileSync(join(inputs, 'manifest.json'), 'utf8')).toBe(manifest);
    expect(JSON.parse(readFileSync(out, 'utf8')).cells.map(({ id }) => id)).toEqual(['helical gear -> glb']);
  });

  it('compares two single-build reports by renaming their builds', () => {
    const one = join(work, 'one.json');
    const two = join(work, 'two.json');
    for (const [path, entry] of [
      [one, base],
      [two, pr],
    ]) {
      run([
        '--backend',
        'native',
        '--tier',
        'small',
        '--runs',
        '1',
        '--models',
        models,
        '--filter',
        'OBJ -> (glb|stl)',
        '--build',
        `local=${entry}`,
        '--out',
        path,
      ]);
    }
    const markdown = execFileSync(process.execPath, [reporter, `base=${one}`, `pr=${two}`], {
      encoding: 'utf8',
    });
    expect(markdown).toContain('| small | native | 2 | 2 |');
    expect(markdown).toMatch(/\| OBJ -> stl \|.*\| changed \|/u);
  });
});

describe('bench/matrix-report.mjs', () => {
  const ok = (overrides) => ({
    status: 'ok',
    medianMs: 100,
    minMs: 95,
    maxMs: 105,
    sha256: 'a',
    stable: true,
    ...overrides,
  });

  it('calls a cell slower or faster only when the runs separate beyond the tier noise', () => {
    expect(compareCell(ok(), ok({ medianMs: 130, minMs: 120, maxMs: 140 }), { to: 'glb' }).time).toBe(
      'slower',
    );
    expect(compareCell(ok(), ok({ medianMs: 80, minMs: 75, maxMs: 85 }), { to: 'glb' }).time).toBe('faster');
    expect(compareCell(ok(), ok({ medianMs: 130, minMs: 100, maxMs: 140 }), { to: 'glb' }).time).toBe('same');
    expect(compareCell(ok(), ok({ medianMs: 108, minMs: 106, maxMs: 110 }), { to: 'glb' }).time).toBe('same');
    const small = { to: 'glb', tier: 'small' };
    expect(compareCell(ok(), ok({ medianMs: 130, minMs: 120, maxMs: 140 }), small).time).toBe('same');
    expect(compareCell(ok(), ok({ medianMs: 260, minMs: 250, maxMs: 270 }), small).time).toBe('slower');
    expect(
      compareCell(ok({ medianMs: 20, minMs: 19, maxMs: 21 }), ok({ medianMs: 5, minMs: 4, maxMs: 6 }), small)
        .time,
    ).toBe('faster');
    const tiny = ok({ medianMs: 1, minMs: 0.9, maxMs: 1.1 });
    expect(compareCell(tiny, ok({ medianMs: 3, minMs: 2.9, maxMs: 3.1 }), { to: 'glb' }).time).toBe('same');
  });

  it('separates changed outputs from timestamped ones and finds new crashes only', () => {
    expect(compareCell(ok(), ok({ sha256: 'b' }), { to: 'glb' }).fingerprint).toBe('changed');
    expect(compareCell(ok(), ok({ sha256: 'b' }), { to: 'fbx' }).fingerprint).toBe('varies');
    expect(compareCell(ok(), ok({ sha256: 'b', stable: false }), { to: 'glb' }).fingerprint).toBe('varies');
    expect(compareCell(ok(), { status: 'crash' }, { to: 'glb' })).toMatchObject({
      newCrash: true,
      statusChanged: true,
    });
    expect(compareCell({ status: 'crash' }, { status: 'crash' }, { to: 'glb' })).toMatchObject({
      newCrash: false,
      statusChanged: false,
    });
    expect(compareCell(undefined, ok(), { to: 'glb' })).toMatchObject({
      status: 'absent → ok',
      statusChanged: true,
    });
  });

  it('merges shards and keeps the comment under the GitHub limit', () => {
    const shard = (id) => ({
      schema: 'libassimp-format-matrix-v1',
      tier: 'large',
      backend: 'wasm',
      runs: 3,
      side: 1024,
      durationMs: 1000,
      builds: {
        base: { rev: '1234567890', calibration: { medianMs: 50 } },
        pr: { rev: 'abcdef1234', calibration: { medianMs: 51 } },
      },
      cells: [
        {
          id,
          from: 'x',
          to: 'glb',
          results: {
            base: ok({ wasmHeapBytes: 2 ** 30, peakRssBytes: 2 ** 31 }),
            pr: ok({ wasmHeapBytes: 2 ** 29, peakRssBytes: 2 ** 31 }),
          },
        },
      ],
    });
    const groups = mergeReports([
      { report: shard('a'.repeat(30_000)) },
      { report: shard('b'.repeat(30_000)) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cells.size).toBe(2);
    const { markdown, newCrashes } = renderMarkdown(groups);
    expect(newCrashes).toEqual([]);
    expect(markdown.length).toBeLessThan(61_000);
    expect(markdown).toContain('`1234567` against pr `abcdef1`');
    expect(markdown).toContain('Truncated');
    const [small] = mergeReports([{ report: shard('c') }]);
    expect(renderMarkdown([small]).markdown).toContain('1024.0 → 512.0 (-50%)');
  });
});

describe('bench/matrix-inputs.mjs', () => {
  it('writes the same grid in every generated format', () => {
    const directory = join(work, 'grid');
    mkdirSync(directory);
    const digests = writeGenerated(directory, 3);
    expect(Object.keys(digests).toSorted()).toEqual(
      Object.values(GENERATED)
        .flatMap(({ files }) => files)
        .toSorted(),
    );
    expect(writeGenerated(directory, 3)).toEqual(digests);
    const obj = readFileSync(join(directory, 'grid.obj'), 'utf8');
    expect(obj.match(/^v /gmu)).toHaveLength(9);
    expect(obj.match(/^f /gmu)).toHaveLength(4);
    expect(readFileSync(join(directory, 'grid.ply'), 'latin1')).toContain('element vertex 9\n');
    expect(readFileSync(join(directory, 'grid.stl')).readUInt32LE(80)).toBe(8);
    const glb = readFileSync(join(directory, 'grid.glb'));
    expect(glb.readUInt32LE(0)).toBe(0x46_54_6c_67);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
    expect(json.accessors.map(({ count }) => count)).toEqual([9, 9, 9, 24]);
    const gltf = JSON.parse(readFileSync(join(directory, 'grid.gltf'), 'utf8'));
    expect(gltf.buffers).toEqual([
      { byteLength: readFileSync(join(directory, 'grid.bin')).length, uri: 'grid.bin' },
    ]);
    expect(readFileSync(join(directory, 'grid.usda'), 'utf8')).toContain(
      'int[] faceVertexCounts = [4, 4, 4, 4]',
    );
  });
});
