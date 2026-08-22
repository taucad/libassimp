import { describe, expect, it } from 'vitest';

import { AssimpError } from './assimp-error.js';
import { createAssimp as createFull, type ExportFormat as FullFormat } from './index.js';
import { createAssimp as createImporter } from './importer.js';
import { createAssimp as createExporter } from './exporter.js';

/** Mirrors `AllExportFormat`; the type test binds the two together. */
export const allExportFormats = [
  '3ds',
  '3mf',
  'assjson',
  'collada',
  'dae',
  'fbx',
  'fbxa',
  'glb',
  'glb1',
  'glb2',
  'gltf',
  'gltf1',
  'gltf2',
  'obj',
  'objnomtl',
  'ply',
  'plyb',
  'step',
  'stl',
  'stlb',
  'stp',
  'usda',
  'usdz',
  'x',
  'x3d',
] as const;

/** Mirrors `GltfExportFormat`. */
export const gltfExportFormats = ['assjson', 'glb', 'glb1', 'glb2', 'gltf', 'gltf1', 'gltf2'] as const;

/** The aliases `src/cpp/libassimp.cpp` resolves, and what each resolves to. */
const aliases = {
  glb: 'glb2',
  gltf: 'gltf2',
  glb1: 'glb',
  gltf1: 'gltf',
  step: 'stp',
  dae: 'collada',
};

const entries = [
  ['libassimp', createFull, allExportFormats],
  ['libassimp/importer', createImporter, gltfExportFormats],
  ['libassimp/exporter', createExporter, allExportFormats],
] as const;

/** Every id the build exports, plus the aliases that resolve to one of them. */
const accepted = (ids: readonly string[]): string[] =>
  [
    ...new Set([
      ...ids,
      ...Object.entries(aliases)
        .filter(([, id]) => ids.includes(id))
        .map(([alias]) => alias),
    ]),
  ].sort();

describe.each(entries)('%s formats', (_name, create, declared) => {
  it('declares exactly the export ids the build carries plus its aliases', async () => {
    using assimp = await create();
    const ids = assimp.formats.export.map(({ id }) => id);
    expect([...declared].sort()).toEqual(accepted(ids));
  });

  it('reports one entry per format id', async () => {
    using assimp = await create();
    for (const table of [assimp.formats.import, assimp.formats.export]) {
      const ids = table.map(({ id }) => id);
      expect(ids).toEqual([...new Set(ids)]);
      expect(table.every(({ extension, description }) => extension !== '' && description !== '')).toBe(true);
    }
  });
});

describe('format tables', () => {
  it('deduplicates importer extensions shared by two importers', async () => {
    using assimp = await createFull();
    const ids = assimp.formats.import.map(({ id }) => id);
    // glTF 1 and glTF 2 both register `gltf` and `glb`.
    expect(ids.filter((id) => id === 'gltf')).toEqual(['gltf']);
    expect(ids).toContain('obj');
    expect(ids.length).toBeGreaterThan(40);
  });

  it('narrows the import table to glTF and USD on the exporter entry', async () => {
    using assimp = await createExporter();
    expect(assimp.formats.import.map(({ id }) => id).sort()).toEqual([
      'glb',
      'gltf',
      'usd',
      'usda',
      'usdc',
      'usdz',
      'vrm',
    ]);
  });

  it('lists the alias vocabulary in the unsupported-format message', async () => {
    using assimp = await createFull();
    const error = (await assimp
      .convert({ name: 'cube.obj', bytes: new Uint8Array() }, { to: 'nope' as FullFormat })
      .catch((thrown: unknown) => thrown)) as AssimpError;
    expect(error.message).toContain(`Aliases: ${Object.keys(aliases).join(', ')}.`);
  });
});
