#!/usr/bin/env node

// Export the USD validation matrix through the built package, for
// `scripts/usd-strict-check.py` to validate with OpenUSD itself.
//
//   node scripts/export-usd-matrix.mjs <output-directory>
//
// Every source goes to USDA, USDC and USDZ. USDA and USDC write their
// textures beside the layer; USDZ must carry everything inside the package.
// Prints the primary layer paths, one per line.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { usdaGrid, usdSidecarScene } from '../tests/generate-usd-fixture.mjs';

const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: node scripts/export-usd-matrix.mjs <output-directory>');

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = await import(pathToFileURL(join(root, 'dist/index.mjs')).href);
const models = join(root, 'assimp/test/models');
const load = (relative) => ({
  name: basename(relative),
  bytes: new Uint8Array(readFileSync(join(models, relative))),
});
const sidecar = usdSidecarScene();

const SOURCES = {
  'box-textured': { files: [load('glTF2/BoxTextured-glTF-Binary/BoxTextured.glb')] },
  'quad-skin': { files: [load('glTF2/simple_skin/quad_skin.glb')] },
  'obj-materials': { files: [load('OBJ/cube_usemtl.obj'), load('OBJ/cube_usemtl.mtl')] },
  'collada-duck': { files: [load('Collada/duck.dae'), load('Collada/duckCM.tga')] },
  grid: { files: [{ name: 'grid.usda', bytes: usdaGrid(64) }] },
  sidecars: {
    files: [sidecar.root],
    resolve: (name) => sidecar.sidecars.get(name.replace(/^\.\//u, '')),
  },
};

const assimp = await entry.createAssimp({ backend: 'wasm' });
try {
  for (const [name, source] of Object.entries(SOURCES)) {
    const results = await assimp.convertFormats(source.files, {
      targets: [{ to: 'usda' }, { to: 'usdc' }, { to: 'usdz' }],
      ...(source.resolve === undefined ? {} : { resolve: source.resolve }),
    });
    for (const { format, files } of results) {
      const directory = join(output, `${name}-${format}`);
      for (const file of files) {
        const path = join(directory, file.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.bytes);
      }
      process.stdout.write(`${join(directory, files[0].name)}\n`);
    }
  }
} finally {
  assimp.dispose();
}
