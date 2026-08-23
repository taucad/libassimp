import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePackageFiles } from './package-files.mjs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('./package.json', root), 'utf8'));
const candidateDirectory = process.env['LIBASSIMP_CANDIDATE_DIR'];

const work = mkdtempSync(join(tmpdir(), 'libassimp-package-'));
const pack = (cwd) => {
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], {
      cwd,
      encoding: 'utf8',
    }),
  );
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(`npm pack returned ${result.length} candidates`);
  }
  return result[0];
};

try {
  const packed = candidateDirectory ? undefined : pack(fileURLToPath(root));
  if (packed) validatePackageFiles(packed.files.map(({ path }) => path));
  const tarball = candidateDirectory
    ? resolve(candidateDirectory, `libassimp-${manifest.version}.tgz`)
    : join(work, packed.filename);
  if (!existsSync(tarball)) throw new Error(`candidate tarball missing: ${tarball}`);

  writeFileSync(join(work, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    {
      cwd: work,
      stdio: 'inherit',
    },
  );

  const fixture = fileURLToPath(new URL('./tests/fixtures/cube.obj', root));
  writeFileSync(
    join(work, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convert } from 'libassimp';
import { convert as convertToGltf } from 'libassimp/importer';
import { convert as convertFromGltf, createAssimp } from 'libassimp/exporter';

const bytes = new Uint8Array(await readFile(process.argv[2]));
const { files } = await convert({ name: 'cube.obj', bytes }, { to: 'glb' });
assert.equal(Buffer.from(files[0].bytes.subarray(0, 4)).toString('latin1'), 'glTF');

const gltf = await convertToGltf({ name: 'cube.obj', bytes }, { to: 'glb' });
const stl = await convertFromGltf({ name: 'model.glb', bytes: gltf.files[0].bytes }, { to: 'stl' });
assert.equal(stl.files[0].name, 'result.stl');

const assimp = await createAssimp();
try {
  assert.ok(assimp.formats.export.some((format) => format.id === 'stl'));
} finally {
  assimp.dispose();
}

for (const specifier of ['libassimp/wasm', 'libassimp/importer/wasm', 'libassimp/exporter/wasm']) {
  const wasm = await readFile(new URL(import.meta.resolve(specifier)));
  assert.ok(WebAssembly.validate(wasm), specifier + ' is not a valid WebAssembly module');
}
`,
  );
  execFileSync(process.execPath, ['consumer.mjs', fixture], { cwd: work, stdio: 'inherit' });

  writeFileSync(
    join(work, 'consumer.cjs'),
    `'use strict';
const assert = require('node:assert/strict');
assert.throws(() => require('libassimp'), /libassimp is ESM-only; use import\\("libassimp"\\) from CommonJS\\./u);
`,
  );
  execFileSync(process.execPath, ['consumer.cjs'], { cwd: work, stdio: 'inherit' });

  const installed = JSON.parse(readFileSync(join(work, 'node_modules/libassimp/package.json'), 'utf8'));
  if (installed.version !== manifest.version) throw new Error('installed package version mismatch');
  console.log(`clean-room package smoke passed for ${process.platform}-${process.arch}`);
} finally {
  rmSync(work, { force: true, recursive: true });
}
