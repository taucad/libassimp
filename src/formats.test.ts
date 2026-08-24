import { describe, expect, it, vi } from 'vitest';

import {
  allExportFormats,
  fullConversionEdges,
  fullImportFormats,
  importerConversionEdges,
  importerExportFormats,
  importerImportFormats,
  exporterConversionEdges,
  exporterImportFormats,
} from './generated/assimp-capabilities.js';

export const canonicalExports = [
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
] as const;

const cross = (imports: readonly { readonly id: string }[], exports: readonly { readonly id: string }[]) =>
  imports.flatMap(({ id: from }) => exports.flatMap(({ id: to }) => (from === to ? [] : [{ from, to }])));

describe('generated format catalogs', () => {
  it('publishes the exact canonical 15/3 export roots', () => {
    expect(allExportFormats.map(({ id }) => id)).toEqual(canonicalExports);
    expect(importerExportFormats.map(({ id }) => id)).toEqual(['assjson', 'glb', 'gltf']);
  });

  it.each([
    { entry: 'full', imports: fullImportFormats, exports: allExportFormats, edges: fullConversionEdges },
    {
      entry: 'importer',
      imports: importerImportFormats,
      exports: importerExportFormats,
      edges: importerConversionEdges,
    },
    {
      entry: 'exporter',
      imports: exporterImportFormats,
      exports: allExportFormats,
      edges: exporterConversionEdges,
    },
  ] as const)('$entry edges are exactly the non-identity cross-product', ({ imports, exports, edges }) => {
    expect(edges).toEqual(cross(imports, exports));
  });

  it('contains no native aliases or glTF 1 names', () => {
    const publicIds = [
      ...allExportFormats.map(({ id }) => id),
      ...importerExportFormats.map(({ id }) => id),
      ...fullConversionEdges.flatMap(({ from, to }) => [from, to]),
    ];
    for (const native of [
      'collada',
      'fbxa',
      'glb1',
      'glb2',
      'gltf1',
      'gltf2',
      'objnomtl',
      'plyb',
      'stlb',
      'stp',
    ]) {
      expect(publicIds).not.toContain(native);
    }
    expect(JSON.stringify({ allExportFormats, importerExportFormats })).not.toMatch(
      /native(?:Id|Name|Kind|Values)/u,
    );
  });

  it('loads static catalogs without fetching or compiling Wasm', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const compile = vi.spyOn(WebAssembly, 'compile');
    await import('./exporter.js');
    expect(fetch).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    fetch.mockRestore();
    compile.mockRestore();
  });
});
