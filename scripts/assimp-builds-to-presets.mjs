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
 * Generates CMakePresets.json from assimp-builds.json. The output is checked
 * in; tests/assimp-builds-presets.test.mjs asserts regeneration is a no-op.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

/** @typedef {{ importers: 'all' | string[], exporters: 'all' | string[], enable?: string[] }} BuildSpec */

/** The parsed source for the production and native-test Assimp builds. */
export const builds = JSON.parse(readFileSync(new URL('assimp-builds.json', root), 'utf8'));

/** Format ids, per side, compiled by one build. */
export const buildFormats = (name) => {
  const spec = name === 'native-test' ? builds.nativeTest : builds[name];
  if (!spec) throw new Error(`Unknown build: ${name}`);
  return { importers: spec.importers, exporters: spec.exporters, disable: builds.disable.ids };
};

/** `ASSIMP_BUILD_<ID>_<SIDE>` cache entries, with shared disables applied last. */
export const buildCacheVariables = (name) => {
  const { importers, exporters } = buildFormats(name);
  const spec = name === 'native-test' ? builds.nativeTest : builds[name];
  const variables = {
    ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT: importers === 'all' ? 'ON' : 'OFF',
    ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT: exporters === 'all' ? 'ON' : 'OFF',
  };
  const set = (id, side, value) => {
    if (id.endsWith('_IMPORTER') || id.endsWith('_EXPORTER')) variables[`ASSIMP_BUILD_${id}`] = value;
    else variables[`ASSIMP_BUILD_${id}_${side}`] = value;
  };
  if (importers !== 'all') for (const id of importers) set(id, 'IMPORTER', 'ON');
  if (exporters !== 'all') for (const id of exporters) set(id, 'EXPORTER', 'ON');
  for (const id of spec.enable ?? []) set(id, 'IMPORTER', 'ON');
  for (const id of builds.disable.ids) {
    if (id.endsWith('_IMPORTER') || id.endsWith('_EXPORTER')) variables[`ASSIMP_BUILD_${id}`] = 'OFF';
    else {
      variables[`ASSIMP_BUILD_${id}_IMPORTER`] = 'OFF';
      variables[`ASSIMP_BUILD_${id}_EXPORTER`] = 'OFF';
    }
  }
  return Object.fromEntries(
    Object.keys(variables)
      .sort()
      .map((key) => [key, variables[key]]),
  );
};

const sharedCacheVariables = Object.fromEntries(
  Object.entries(builds.cacheVariables).filter(([key]) => key !== '$comment'),
);

const presets = {
  version: 6,
  configurePresets: [
    {
      name: 'wasm',
      displayName: 'wasm',
      generator: 'Ninja',
      binaryDir: '${sourceDir}/build/wasm',
      cacheVariables: {
        CMAKE_BUILD_TYPE: 'Release',
        CMAKE_C_COMPILER_LAUNCHER: 'ccache',
        CMAKE_CXX_COMPILER_LAUNCHER: 'ccache',
        ...sharedCacheVariables,
        ...buildCacheVariables('wasm'),
      },
    },
    {
      name: 'native-test',
      displayName: 'native ctest',
      generator: 'Ninja',
      binaryDir: '${sourceDir}/build/native-test',
      cacheVariables: {
        CMAKE_BUILD_TYPE: 'Release',
        LIBASSIMP_NATIVE_TESTS: 'ON',
        CMAKE_C_COMPILER_LAUNCHER: 'ccache',
        CMAKE_CXX_COMPILER_LAUNCHER: 'ccache',
        ...Object.fromEntries(
          Object.entries(sharedCacheVariables).filter(
            // lib3mf is an import-side FetchContent dependency; the ctest leg has to stay cheap.
            // The vendored zlib no longer compiles against the macOS SDK; CI hosts ship zlib.
            ([key]) => key !== 'ASSIMP_BUILD_3MF_LIB3MF' && key !== 'ASSIMP_BUILD_ZLIB',
          ),
        ),
        ASSIMP_BUILD_3MF_LIB3MF: 'OFF',
        ASSIMP_BUILD_ZLIB: 'OFF',
        ...buildCacheVariables('native-test'),
      },
    },
  ],
  buildPresets: [
    { name: 'wasm', configurePreset: 'wasm' },
    { name: 'native-test', configurePreset: 'native-test' },
  ],
  testPresets: [
    {
      name: 'native-test',
      configurePreset: 'native-test',
      output: { outputOnFailure: true },
    },
  ],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('CMakePresets.json', root), `${JSON.stringify(presets, undefined, 2)}\n`);
}
