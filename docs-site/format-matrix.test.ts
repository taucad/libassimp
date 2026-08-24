import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import matrix from './content/docs/format-matrix.json';

const ROOT = resolve(import.meta.dirname, '..');
const committed = resolve(import.meta.dirname, 'content/docs/format-matrix.json');

/** Regenerating reads the built entries, so the check needs a built package. */
const built = ['index', 'importer', 'exporter'].every((entry) =>
  existsSync(resolve(ROOT, `dist/${entry}.mjs`)),
);
const generatedTest = built ? it : it.skip;

describe('format matrix', () => {
  it('carries a table for every build', () => {
    expect(Object.keys(matrix)).toEqual(['full', 'importer', 'exporter']);
    for (const tables of Object.values(matrix)) {
      expect(tables.import.length).toBeGreaterThan(0);
      expect(tables.export.length).toBeGreaterThan(0);
    }
  });

  it('uses the exact canonical export vocabulary and option routes', () => {
    expect(matrix.full.export.map(({ id }) => id)).toEqual([
      '3ds',
      '3mf',
      'assjson',
      'dae',
      'fbx',
      'glb',
      'gltf',
      'obj',
      'ply',
      'step',
      'stl',
      'usda',
      'usdz',
      'x',
      'x3d',
    ]);
    expect(matrix.importer.export.map(({ id }) => id)).toEqual(['assjson', 'glb', 'gltf']);
    expect(Object.keys(matrix.full.export.find(({ id }) => id === 'stl')?.exportOptions ?? {})).toContain(
      'binary',
    );
    expect(Object.keys(matrix.full.export.find(({ id }) => id === 'obj')?.exportOptions ?? {})).toContain(
      'materials',
    );
    expect(JSON.stringify(matrix)).not.toMatch(/glb1|gltf1|glb2|gltf2|objnomtl|plyb|stlb/u);
  });

  generatedTest('regenerates to the committed file, when the package is built', () => {
    const before = readFileSync(committed, 'utf8');
    execFileSync(process.execPath, [resolve(import.meta.dirname, 'scripts/format-matrix.mjs')], {
      stdio: 'pipe',
    });
    expect(readFileSync(committed, 'utf8'), 'run `pnpm run format-matrix` and review the diff').toEqual(
      before,
    );
  });
});
