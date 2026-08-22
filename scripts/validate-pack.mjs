import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { validatePackageFiles } from './package-files.mjs';

const VARIANTS = ['full', 'importer', 'exporter'];

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
);
if (!Array.isArray(packed) || packed.length !== 1) {
  throw new Error('npm pack must describe exactly one tarball');
}

const files = validatePackageFiles(packed[0].files.map(({ path }) => path));

// The tarball carries no manifests, so the provenance of the binaries it does
// carry is asserted against the build records left in `src/wasm/`. The engine
// commit comes from the superproject's gitlink, which a checkout without
// submodules still records.
const image = readFileSync(new URL('../emsdk-image.txt', import.meta.url), 'utf8').trim();
const engineSha = execFileSync('git', ['ls-tree', 'HEAD', 'assimp'], { encoding: 'utf8' }).split(/\s+/u)[2];
for (const variant of VARIANTS) {
  const path = new URL(`../src/wasm/libassimp-${variant}.manifest.json`, import.meta.url);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const mismatch = [
    manifest.fast === true && 'built with LIBASSIMP_FAST',
    manifest.image !== image && `built from ${manifest.image}, not ${image}`,
    manifest.engineSha !== engineSha && `built from engine ${manifest.engineSha}, not ${engineSha}`,
  ].filter(Boolean);
  if (mismatch.length > 0) throw new Error(`libassimp-${variant}: ${mismatch.join('; ')}`);
}

console.log(`npm package contains ${files.length} files built from ${image} and engine ${engineSha}`);
