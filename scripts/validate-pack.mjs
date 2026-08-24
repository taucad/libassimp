import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { validatePackageFiles } from './package-files.mjs';

const VARIANTS = ['full', 'importer', 'exporter'];

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
);
if (!Array.isArray(packed) || packed.length !== 1) {
  throw new Error('npm pack must describe exactly one tarball');
}

const files = validatePackageFiles(packed[0].files.map(({ path }) => path));
const wasmArtifacts = files.filter((path) =>
  /^dist\/wasm\/libassimp-(?:full|importer|exporter)\.(?:js|wasm)$/u.test(path),
);
if (wasmArtifacts.length !== 6)
  throw new Error(`expected three glue/Wasm pairs, found ${wasmArtifacts.length} files`);
if (files.some((path) => /(?:jspi|asyncify|replay)/iu.test(path))) {
  throw new Error('package contains a mode-specific artifact');
}

// The tarball carries no manifests, so the provenance of the binaries it does
// carry is asserted against the build records left in `src/wasm/`. The engine
// commit comes from the checked-out submodule when present, or the
// superproject's gitlink in a source-only checkout.
const image = readFileSync(new URL('../emsdk-image.txt', import.meta.url), 'utf8').trim();
const engineSha = existsSync(new URL('../assimp/.git', import.meta.url))
  ? execFileSync('git', ['-C', 'assimp', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  : execFileSync('git', ['ls-tree', 'HEAD', 'assimp'], { encoding: 'utf8' }).split(/\s+/u)[2];
for (const variant of VARIANTS) {
  const path = new URL(`../src/wasm/libassimp-${variant}.manifest.json`, import.meta.url);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const mismatch = [
    manifest.fast === true && 'built with LIBASSIMP_FAST',
    manifest.image !== image && `built from ${manifest.image}, not ${image}`,
    manifest.engineSha !== engineSha && `built from engine ${manifest.engineSha}, not ${engineSha}`,
    !manifest.compileFlags?.includes('-O3') && 'compile flags omit -O3',
    !manifest.linkFlags?.includes('-O3') && 'link flags omit -O3',
    !manifest.linkFlags?.includes('-sWASM_LEGACY_EXCEPTIONS=1') && 'legacy Wasm EH is not pinned',
    manifest.finalOptimizerFlags?.[0] !== '-O4' && 'final optimizer is not -O4',
    manifest.inventory?.rawPlanExport !== true && 'stable raw plan export is absent',
    manifest.inventory?.missingImport?.kind !== 'function' &&
      'dispatch is not the sole missing function import',
    [
      ...(manifest.compileFlags ?? []),
      ...(manifest.linkFlags ?? []),
      ...(manifest.finalOptimizerFlags ?? []),
    ].some((flag) => /(?:ASYNCIFY|JSPI)/u.test(flag)) && 'contains JSPI or Asyncify build flags',
  ].filter(Boolean);
  if (mismatch.length > 0) throw new Error(`libassimp-${variant}: ${mismatch.join('; ')}`);
}

console.log(`npm package contains ${files.length} files built from ${image} and engine ${engineSha}`);
