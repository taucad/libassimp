import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as generated from './native/loader.fixture.test.js';

describe('Node-conditioned entry', () => {
  it('has public parity and loads native only when an instance is requested', async () => {
    const node = await import('./index.node.js');
    const browser = await import('./index.js');
    expect(Object.keys(node).toSorted()).toEqual(Object.keys(browser).toSorted());
    expect(generated.preparePlan).not.toHaveBeenCalled();

    using assimp = await node.createAssimp();
    expect(assimp).toMatchObject({
      backend: 'native',
      buildIdentity: `${process.platform}-${process.arch}-napi8`,
    });
  });

  it('keeps one-shot conversion helpers on the shared native instance', async () => {
    const { convert, convertFormats } = await import('./index.node.js');
    await expect(convert({ name: 'cube.obj', bytes: new Uint8Array([1]) }, { to: 'glb' })).resolves.toEqual({
      files: [],
    });
    await expect(
      convertFormats({ name: 'cube.obj', bytes: new Uint8Array([1]) }, { targets: [{ to: 'glb' }] }),
    ).resolves.toEqual([{ format: 'glb', files: [] }]);
  });

  it('can force the unchanged Wasm runtime', async () => {
    const { createAssimp } = await import('./index.node.js');
    using assimp = await createAssimp({ backend: 'wasm' });
    expect(assimp).toMatchObject({ backend: 'wasm' });
    expect(assimp).not.toHaveProperty('buildIdentity');
  });

  it('keeps the browser entry graph free of the Node adapter', () => {
    for (const path of ['./index.ts', './create-assimp.ts', './convert.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/(?:from|import\()\s*['"].*(?:index\.node|native-backend|native\/)/u);
    }
  });
});
