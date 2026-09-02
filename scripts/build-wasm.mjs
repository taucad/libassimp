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
 * Builds the production Wasm artifact.
 *
 *   node scripts/build-wasm.mjs [--fast]
 *
 * Runs inside the digest-pinned emsdk container by default. `LIBASSIMP_EMSDK=host`
 * builds on the host instead — that is the CI path, where the job already runs
 * inside the same container. Artefacts land in src/wasm/ only after a clean build.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const wasmDir = `${root}src/wasm`;
const emsdk = process.env.LIBASSIMP_EMSDK === 'host' ? process.env.EMSDK : '/emsdk';
const wasmOpt = emsdk ? `${emsdk}/upstream/bin/wasm-opt` : 'wasm-opt';
const wasmDis = emsdk ? `${emsdk}/upstream/bin/wasm-dis` : 'wasm-dis';
const wasmOptFlags = [
  '-O4',
  '--strip-debug',
  '--strip-producers',
  '--enable-mutable-globals',
  '--enable-bulk-memory',
  '--enable-sign-ext',
  '--enable-nontrapping-float-to-int',
  '--traps-never-happen',
  '--converge',
  '--enable-exception-handling',
  '--enable-simd',
  '--skip-pass=code-folding',
];

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const unknownArgs = args.filter((argument) => argument !== '--fast');
if (unknownArgs.length > 0) {
  console.error('Usage: build-wasm.mjs [--fast]');
  process.exit(1);
}

const image = (process.env.LIBASSIMP_EMSDK_IMAGE ?? readFileSync(`${root}emsdk-image.txt`, 'utf8')).trim();
const engineSha = run('git', ['-C', `${root}assimp`, 'rev-parse', 'HEAD']).trim();
// Deterministic and content-derived: the engine commit this artefact was built from.
const sourceDateEpoch =
  process.env.SOURCE_DATE_EPOCH ?? run('git', ['-C', `${root}assimp`, 'log', '-1', '--format=%ct']).trim();
const buildConfigSha256 = createHash('sha256')
  .update(readFileSync(`${root}assimp-builds.json`))
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

async function inspectArtifact(wasmPath, gluePath) {
  const bytes = readFileSync(wasmPath);
  const compiled = await WebAssembly.compile(bytes);
  let missing;
  let resolveInstantiation;
  const instantiationRequested = new Promise((resolve) => {
    resolveInstantiation = resolve;
  });
  const factory = (await import(`${pathToFileURL(gluePath).href}?built=${Date.now()}`)).default;
  const nativePromise = factory({
    instantiateWasm(imports, receive) {
      missing = WebAssembly.Module.imports(compiled).filter(({ kind, module, name }) => {
        const supplied = imports[module]?.[name];
        return kind === 'function' ? typeof supplied !== 'function' : supplied === undefined;
      });
      if (missing.length !== 1 || missing[0].kind !== 'function') {
        throw new Error(`expected one missing dispatch function, found ${missing.length}`);
      }
      imports[missing[0].module] ??= {};
      imports[missing[0].module][missing[0].name] = () => 0;
      const instantiation = WebAssembly.instantiate(compiled, imports).then((instance) => {
        receive(instance);
        return instance;
      });
      resolveInstantiation(instantiation);
      return {};
    },
  });
  await Promise.race([
    instantiationRequested,
    Promise.resolve(nativePromise).then(() => {
      throw new Error('generated glue did not request Wasm instantiation');
    }),
  ]);
  const native = await nativePromise;
  if (typeof native._libassimp_run_plan !== 'function') {
    throw new Error('generated glue does not preserve _libassimp_run_plan');
  }
  return {
    missingImport: missing[0],
    rawPlanExport: true,
    imports: WebAssembly.Module.imports(compiled),
    exports: WebAssembly.Module.exports(compiled),
  };
}

mkdirSync(wasmDir, { recursive: true });

const target = 'libassimp';
const buildPath = 'build/wasm';
const buildDir = `${root}build/wasm`;
const started = Date.now();

build(
  `emcmake cmake --preset wasm -DLIBASSIMP_FAST=${fast ? 'ON' : 'OFF'} ` +
    `&& cmake --build --preset wasm --parallel`,
  { stdio: 'inherit' },
);

// `--emit-tsd` executes the module during link and cannot instantiate the
// intentionally host-supplied dispatch import. The glue is private, so its
// declaration only needs to describe the modularized factory boundary.
writeFileSync(
  `${buildDir}/${target}.d.ts`,
  'declare const factory: (options?: Record<string, unknown>) => Promise<unknown>;\nexport default factory;\n',
);

let wasmArtifact = `${buildDir}/${target}.wasm`;
if (!fast) {
  build(
    `${wasmOpt} ${buildPath}/${target}.wasm ${wasmOptFlags.join(' ')} ` +
      `--output=${buildPath}/${target}.optimized.wasm`,
    { stdio: 'inherit' },
  );
  wasmArtifact = `${buildDir}/${target}.optimized.wasm`;
}

const opcodeInspection = build(
  `set -o pipefail; ${wasmDis} ${wasmArtifact.slice(root.length)} -o - | ` +
    `awk -v target=${target} '` +
    `/try_table/{table++} /\\(try /{legacy++} {line=tolower($0); if(line ~ /asyncify/) asyncify++} ` +
    `END{printf "%s legacy_try=%d try_table=%d asyncify=%d\\n",target,legacy,table,asyncify; ` +
    `exit(table != 0 || asyncify != 0 || legacy == 0)}'`,
).trim();
console.log(opcodeInspection);

const ninja = readFileSync(`${buildDir}/build.ninja`, 'utf8');
const compileFlags = /^ *FLAGS = (.*)$/m.exec(ninja)?.[1].trim().split(/\s+/u) ?? [];
const linkFlags = /^ *LINK_FLAGS = (.*)$/m.exec(ninja)?.[1].trim().split(/\s+/u) ?? [];
if (!fast) {
  for (const flag of ['-O3', '-fwasm-exceptions', '-msimd128']) {
    if (!compileFlags.includes(flag)) throw new Error(`${target} compile flags omit ${flag}`);
    if (!linkFlags.includes(flag)) throw new Error(`${target} link flags omit ${flag}`);
  }
  for (const flag of ['--closure=1', '-sEVAL_CTORS=2', '-sMALLOC=mimalloc', '-sWASM_LEGACY_EXCEPTIONS=1']) {
    if (!linkFlags.includes(flag)) throw new Error(`${target} link flags omit ${flag}`);
  }
}
const forbiddenFlags = [...compileFlags, ...linkFlags, ...wasmOptFlags].filter((flag) =>
  /(?:ASYNCIFY|JSPI)/u.test(flag),
);
if (forbiddenFlags.length > 0)
  throw new Error(`${target} contains forbidden flags: ${forbiddenFlags.join(', ')}`);
const emccVersion = build('emcc --version').split('\n')[0].trim();

for (const suffix of ['.js', '.wasm', '.d.ts', '.js.symbols']) {
  copyArtifact(
    suffix === '.wasm' ? wasmArtifact : `${buildDir}/${target}${suffix}`,
    `${wasmDir}/${target}${suffix}`,
  );
}

const wasm = readFileSync(`${wasmDir}/${target}.wasm`);
const glue = readFileSync(`${wasmDir}/${target}.js`);
const inventory = await inspectArtifact(`${wasmDir}/${target}.wasm`, `${wasmDir}/${target}.js`);
for (const [name, bytes] of [
  ['wasm', wasm],
  ['glue', glue],
]) {
  // The host checkout, the container mount, and the GitHub Actions workspace: the
  // binary must name none of them, whichever machine produced it. Anchored, because
  // plenty of legitimately relative paths end in `/src/`.
  const text = bytes.toString('latin1');
  for (const path of [root.replace(/\/$/, ''), '/src/', '/__w/']) {
    if (new RegExp(`(?<![\\w./-])${RegExp.escape(path)}`, 'u').test(text)) {
      throw new Error([target, name, 'embeds the build path', path].join(' '));
    }
  }
}

writeFileSync(
  `${wasmDir}/${target}.manifest.json`,
  `${JSON.stringify(
    {
      image,
      engineSha,
      buildConfigSha256,
      compileFlags,
      linkFlags,
      definitions: ['ASSIMP_BUILD_NO_GLTF1_IMPORTER', 'ASSIMP_BUILD_NO_GLTF1_EXPORTER'],
      wasmSettings: ['WASM_LEGACY_EXCEPTIONS=1'],
      finalOptimizerFlags: fast ? [] : wasmOptFlags,
      fast,
      inventory,
      sizes: {
        wasm: { raw: wasm.length, gzip: gzipSync(wasm).length, brotli: brotliCompressSync(wasm).length },
        js: { raw: glue.length, gzip: gzipSync(glue).length, brotli: brotliCompressSync(glue).length },
      },
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
