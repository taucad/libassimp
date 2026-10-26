// Hostile nesting: every recursive reader in the engine stops at
// `AI_CONFIG_IMPORT_MAX_NODE_DEPTH` and rejects the file with IMPORT_FAILED
// instead of overflowing the Wasm stack. `native-parity.mjs` runs the same
// fixtures against the Node-API backend.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAssimp } from '../src/index.ts';
import {
  HOSTILE_NODE_DEPTH,
  MAX_NODE_DEPTH,
  SAFE_NODE_DEPTH,
  adversarialFixtures,
  deepGltf,
} from './generate-adversarial-fixtures.mjs';

const text = (bytes) => new TextDecoder().decode(bytes);

/** Depth of the deepest node in an assjson scene, walked iteratively. */
const sceneDepth = (scene) => {
  let deepest = 0;
  const stack = [[scene.rootnode, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    deepest = Math.max(deepest, depth);
    for (const child of node.children ?? []) stack.push([child, depth + 1]);
  }
  return deepest;
};

let assimp;

beforeAll(async () => {
  assimp = await createAssimp();
});

afterAll(() => {
  assimp?.dispose();
});

describe('scene-graph nesting cap', () => {
  it.each(Object.entries(adversarialFixtures(HOSTILE_NODE_DEPTH)))('rejects %s', async (name, bytes) => {
    await expect(assimp.convert({ name, bytes }, { to: 'glb' })).rejects.toMatchObject({
      code: 'IMPORT_FAILED',
    });
  });

  it.each(
    Object.entries(adversarialFixtures(SAFE_NODE_DEPTH)).filter(
      ([name]) => !name.startsWith('deep-cycle') && !name.startsWith('deep-records'),
    ),
  )('reads %s', async (name, bytes) => {
    const { files } = await assimp.convert({ name, bytes }, { to: 'assjson' });
    const scene = JSON.parse(text(files[0].bytes));
    expect(scene.meshes).toHaveLength(1);
    // Scopes nest FBX syntax, not scene nodes.
    const nodeDepth = name.startsWith('deep-scopes') ? 1 : SAFE_NODE_DEPTH;
    expect(sceneDepth(scene)).toBeGreaterThanOrEqual(nodeDepth);
  });

  it('converts a chain exactly at the cap with the default post-processing', async () => {
    const name = `deep-${MAX_NODE_DEPTH}.gltf`;
    const { files } = await assimp.convert({ name, bytes: deepGltf(MAX_NODE_DEPTH) }, { to: 'assjson' });
    expect(sceneDepth(JSON.parse(text(files[0].bytes)))).toBe(MAX_NODE_DEPTH);
    const glb = await assimp.convert({ name, bytes: deepGltf(MAX_NODE_DEPTH) }, { to: 'glb' });
    expect(glb.files[0].bytes.byteLength).toBeGreaterThan(0);
  });

  it('rejects a chain one level past the cap, and a cycle', async () => {
    await expect(
      assimp.convert({ name: 'over.gltf', bytes: deepGltf(MAX_NODE_DEPTH + 1) }, { to: 'glb' }),
    ).rejects.toMatchObject({ code: 'IMPORT_FAILED', message: expect.stringContaining('nest deeper than') });
    await expect(
      assimp.convert({ name: 'cycle.gltf', bytes: deepGltf(4, { cycle: true }) }, { to: 'glb' }),
    ).rejects.toMatchObject({
      code: 'IMPORT_FAILED',
      message: expect.stringContaining('recursive reference'),
    });
  });

  it('keeps only the first parent of a glTF node listed under two', async () => {
    const json = JSON.parse(text(deepGltf(1)));
    json.nodes = [{ children: [2] }, { children: [2] }, { mesh: 0 }];
    json.scenes = [{ nodes: [0, 1] }];
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const { files } = await assimp.convert({ name: 'shared.gltf', bytes }, { to: 'assjson' });
    const scene = JSON.parse(text(files[0].bytes));
    const meshNodes = [];
    const stack = [scene.rootnode];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.meshes?.length) meshNodes.push(node);
      stack.push(...(node.children ?? []));
    }
    expect(meshNodes).toHaveLength(1);
  });
});
