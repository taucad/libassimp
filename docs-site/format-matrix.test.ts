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

  it('keeps the aliases the export vocabulary documents', () => {
    const ids = new Set(matrix.full.export.map(({ id }) => id));
    for (const id of ['glb2', 'gltf2', 'stp', 'collada']) expect(ids.has(id)).toBe(true);
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
