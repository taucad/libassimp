// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNapiTargets } from './lib/napi-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = new Set(process.argv.slice(2).filter((value) => value !== '--'));
const unknown = [...arguments_].filter(
  (value) => !['--coverage', '--debug', '--sanitize', '--test'].includes(value),
);
if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(', ')}`);

const nodeEnvironment = { ...process.env };
if (arguments_.has('--sanitize') && process.platform === 'darwin') {
  const probe = spawnSync('xcrun', ['clang', '-print-file-name=libclang_rt.asan_osx_dynamic.dylib'], {
    encoding: 'utf8',
  });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`xcrun failed: ${probe.stderr?.trim() ?? 'unknown error'}`);
  const runtime = probe.stdout.trim();
  if (!existsSync(runtime)) throw new Error(`AddressSanitizer runtime was not found: ${runtime}`);
  nodeEnvironment.DYLD_INSERT_LIBRARIES = runtime;
}

const run = (command, args, environment = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const require = createRequire(import.meta.url);
let nodeAddonApi = process.env.NODE_ADDON_API_DIR;
if (nodeAddonApi === undefined) {
  try {
    nodeAddonApi = dirname(require.resolve('node-addon-api/package.json'));
  } catch {
    throw new Error(
      'node-addon-api is not installed; install the approved dependency or set NODE_ADDON_API_DIR',
    );
  }
}
if (!existsSync(resolve(nodeAddonApi, 'napi.h'))) {
  throw new Error(`NODE_ADDON_API_DIR has no napi.h: ${nodeAddonApi}`);
}

const nodeInclude = process.env.CMAKE_JS_INC ?? resolve(dirname(process.execPath), '..', 'include', 'node');
if (!existsSync(resolve(nodeInclude.split(';')[0], 'node_api.h'))) {
  throw new Error(`Node headers were not found in CMAKE_JS_INC: ${nodeInclude}`);
}

const binaryDirectory = resolve(root, process.env.LIBASSIMP_NATIVE_BUILD_DIR ?? 'build/native');
const outputDirectory = process.env.CMAKE_JS_OUTPUT_DIR ?? binaryDirectory;
const { napiVersion } = readNapiTargets(new URL('../package.json', import.meta.url));
const nativeTests = arguments_.has('--test') || arguments_.has('--coverage') || arguments_.has('--sanitize');
const definitions = [
  `-DNODE_ADDON_API_DIR=${nodeAddonApi}`,
  `-DCMAKE_JS_INC=${nodeInclude}`,
  `-DCMAKE_JS_LIB=${process.env.CMAKE_JS_LIB ?? ''}`,
  `-DCMAKE_JS_SRC=${process.env.CMAKE_JS_SRC ?? ''}`,
  `-DCMAKE_JS_OUTPUT_DIR=${outputDirectory}`,
  `-DLIBASSIMP_NATIVE_BUILD_IDENTITY=${process.platform}-${process.arch}-napi${napiVersion}`,
  `-DLIBASSIMP_NATIVE_TESTS=${nativeTests ? 'ON' : 'OFF'}`,
  `-DLIBASSIMP_CPP_COVERAGE=${arguments_.has('--coverage') ? 'ON' : 'OFF'}`,
  `-DLIBASSIMP_SANITIZERS=${arguments_.has('--sanitize') ? 'ON' : 'OFF'}`,
];
if (process.platform === 'darwin') {
  definitions.push('-DASSIMP_BUILD_ZLIB=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0');
}
if (arguments_.has('--debug') || arguments_.has('--coverage') || arguments_.has('--sanitize')) {
  definitions.push('-DCMAKE_BUILD_TYPE=Debug');
}
run('cmake', ['--preset', 'native', '-B', binaryDirectory, '-DLIBASSIMP_NATIVE_ADDON=ON', ...definitions]);
run('cmake', ['--build', binaryDirectory, '--parallel']);
if (nativeTests) run('ctest', ['--test-dir', binaryDirectory, '--output-on-failure'], nodeEnvironment);

const addonFiles = readdirSync(outputDirectory, { recursive: true }).filter(
  (path) => path.split(/[\\/]/u).at(-1) === 'libassimp.node',
);
if (addonFiles.length !== 1) {
  throw new Error(`expected one libassimp.node under ${outputDirectory}, found ${addonFiles.length}`);
}
const addon = resolve(outputDirectory, addonFiles[0]);
if (![...arguments_].some((value) => ['--coverage', '--debug', '--sanitize'].includes(value))) {
  if (process.platform === 'darwin') run('xcrun', ['strip', '-x', addon]);
  if (process.platform === 'linux') run('strip', ['--strip-unneeded', addon]);
}
run('node', [resolve(root, 'scripts/check-cpp-exports.mjs'), addon], nodeEnvironment);
if (![...arguments_].some((value) => ['--coverage', '--debug', '--sanitize'].includes(value))) {
  run('node', [resolve(root, 'scripts/check-native-host.mjs'), addon]);
}
if (arguments_.has('--test') || arguments_.has('--coverage')) {
  run('node', [resolve(root, 'src/cpp/node-addon.test.mjs')], {
    ...nodeEnvironment,
    LIBASSIMP_NATIVE_ADDON: addon,
  });
}
if (arguments_.has('--coverage')) {
  run('node', [resolve(root, 'scripts/check-cpp-coverage.mjs')], {
    ...process.env,
    LIBASSIMP_COVERAGE_DIR: resolve(binaryDirectory, 'coverage'),
    LIBASSIMP_NATIVE_ADDON: addon,
    LIBASSIMP_TEST_BINARY: resolve(binaryDirectory, 'libassimp-native-test'),
  });
}
