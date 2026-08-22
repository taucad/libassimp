#!/usr/bin/env node
/*
 * Copyright 2026 Richard Fontein
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Builds one or every wasm variant.
 *
 *   node scripts/build-wasm.mjs --variant exporter [--fast]
 *   node scripts/build-wasm.mjs --all
 *
 * Runs inside the digest-pinned emsdk container by default. `LIBASSIMP_EMSDK=host`
 * builds on the host instead — that is the CI path, where the job already runs
 * inside the same container. Artefacts land in src/wasm/ only after a clean build.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wasmDir = `${root}src/wasm`;

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const variantsJson = JSON.parse(readFileSync(`${root}variants.json`, 'utf8'));
const names = args.includes('--all')
  ? Object.keys(variantsJson.variants)
  : [args[args.indexOf('--variant') + 1]].filter((name) => name in variantsJson.variants);

if (names.length === 0) {
  console.error('Usage: build-wasm.mjs --variant <full|importer|exporter> | --all [--fast]');
  process.exit(1);
}

const image = (process.env.LIBASSIMP_EMSDK_IMAGE ?? readFileSync(`${root}emsdk-image.txt`, 'utf8')).trim();
const engineSha = run('git', ['-C', `${root}assimp`, 'rev-parse', 'HEAD']).trim();
// Deterministic and content-derived: the engine commit this artefact was built from.
const sourceDateEpoch =
  process.env.SOURCE_DATE_EPOCH ?? run('git', ['-C', `${root}assimp`, 'log', '-1', '--format=%ct']).trim();
const variantsSha256 = createHash('sha256')
  .update(readFileSync(`${root}variants.json`))
  .digest('hex');

function run(command, commandArgs) {
  return execFileSync(command, commandArgs, { cwd: root, encoding: 'utf8' });
}

/** The emsdk image plus ninja and ccache, built once and reused from the local docker cache. */
function derivedImage() {
  const tag = `libassimp-emsdk:${image.split(':').at(-1).slice(0, 12)}`;
  const dockerfile = `FROM ${image}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ccache ninja-build \\
 && rm -rf /var/lib/apt/lists/*
`;
  execFileSync('docker', ['build', '--quiet', '--tag', tag, '-'], {
    cwd: root,
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return tag;
}

/** Runs a shell line in the build environment: the container, or the host when LIBASSIMP_EMSDK=host. */
function build(script, options = {}) {
  if (process.env.LIBASSIMP_EMSDK === 'host') {
    return execFileSync('bash', ['-lc', script], { cwd: root, encoding: 'utf8', ...options });
  }
  const dockerArgs = [
    'run',
    '--rm',
    '--init',
    '--volume',
    `${root}:/src`,
    '--workdir',
    '/src',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--env',
    'HOME=/tmp',
    '--env',
    'CCACHE_DIR=/src/.ccache',
    // emcc's own cache lives under the mount too, so the container user can write it.
    '--env',
    'EM_CACHE=/src/build/.emcache',
    '--env',
    `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
    derivedImage(),
    'bash',
    '-lc',
    script,
  ];
  return execFileSync('docker', dockerArgs, { cwd: root, encoding: 'utf8', ...options });
}

function copyArtifact(from, to) {
  const temporary = `${to}.tmp`;
  copyFileSync(from, temporary);
  renameSync(temporary, to);
}

mkdirSync(wasmDir, { recursive: true });

for (const variant of names) {
  const target = `libassimp-${variant}`;
  const buildDir = `${root}build/wasm-${variant}`;
  const started = Date.now();

  build(
    `emcmake cmake --preset wasm-${variant} -DLIBASSIMP_FAST=${fast ? 'ON' : 'OFF'} ` +
      `&& cmake --build --preset wasm-${variant} --parallel`,
    { stdio: 'inherit' },
  );

  const linkFlags = /^ *LINK_FLAGS = (.*)$/m.exec(readFileSync(`${buildDir}/build.ninja`, 'utf8'));
  const emccVersion = build('emcc --version').split('\n')[0].trim();

  for (const suffix of ['.js', '.wasm', '.d.ts', '.js.symbols']) {
    copyArtifact(`${buildDir}/${target}${suffix}`, `${wasmDir}/${target}${suffix}`);
  }

  const wasm = readFileSync(`${wasmDir}/${target}.wasm`);
  const glue = readFileSync(`${wasmDir}/${target}.js`);
  for (const [name, bytes] of [
    ['wasm', wasm],
    ['glue', glue],
  ]) {
    if (bytes.includes(root.replace(/\/$/, ''))) {
      throw new Error(`${target} ${name} embeds the checkout path ${root}`);
    }
  }

  writeFileSync(
    `${wasmDir}/${target}.manifest.json`,
    `${JSON.stringify(
      {
        variant,
        image,
        engineSha,
        variantsSha256,
        flags: linkFlags === null ? [] : linkFlags[1].trim().split(/\s+/),
        fast,
        sizes: { wasm: wasm.length, js: glue.length },
        sourceDateEpoch,
        emccVersion,
        builtAt: new Date().toISOString(),
      },
      undefined,
      2,
    )}\n`,
  );

  console.log(
    `${target}: ${fast ? 'fast' : 'production'} build in ${Math.round((Date.now() - started) / 1000)}s, ` +
      `wasm ${wasm.length} B, glue ${glue.length} B`,
  );
}
