import { describe, expect, it, vi } from 'vitest';

import { conversionEdges, exportFormats, importFormats } from './generated/assimp-capabilities.js';

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
  it('publishes the exact canonical 15 export roots', () => {
    expect(exportFormats.map(({ id }) => id)).toEqual(canonicalExports);
  });

  it('publishes the exact compiled 69 import roots', () => {
    expect(importFormats).toHaveLength(69);
  });

  it('publishes exactly the non-identity import/export cross-product', () => {
    expect(conversionEdges).toEqual(cross(importFormats, exportFormats));
  });

  it('contains no native aliases or glTF 1 names', () => {
    const publicIds = [
      ...exportFormats.map(({ id }) => id),
      ...conversionEdges.flatMap(({ from, to }) => [from, to]),
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
    expect(JSON.stringify(exportFormats)).not.toMatch(/native(?:Id|Name|Kind|Values)/u);
  });

  it('loads static catalogs without fetching or compiling Wasm', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const compile = vi.spyOn(WebAssembly, 'compile');
    await import('./index.js');
    expect(fetch).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    fetch.mockRestore();
    compile.mockRestore();
  });
});
