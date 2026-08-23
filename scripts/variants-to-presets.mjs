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
 * Generates CMakePresets.json from variants.json. The output is checked in;
 * tests/variants-presets.test.mjs asserts regenerating it changes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

/** @typedef {{ importers: 'all' | string[], exporters: 'all' | string[], enable?: string[] }} VariantSpec */

/** The parsed variants.json: the single source for which formats each entry compiles in. */
export const variants = JSON.parse(readFileSync(new URL('variants.json', root), 'utf8'));

/** Format ids, per side, that a variant compiles in — `'all'` means assimp's full set minus `disable`. */
export function variantFormats(name) {
  const spec = name === 'native-test' ? variants.nativeTest : variants.variants[name];
  if (!spec) throw new Error(`Unknown variant: ${name}`);
  return { importers: spec.importers, exporters: spec.exporters, disable: variants.disable.ids };
}

/** `ASSIMP_BUILD_<ID>_<SIDE>` cache entries for one variant, disables applied last so they always win. */
export function variantCacheVariables(name) {
  const { importers, exporters } = variantFormats(name);
  const spec = name === 'native-test' ? variants.nativeTest : variants.variants[name];
  const vars = {
    ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT: importers === 'all' ? 'ON' : 'OFF',
    ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT: exporters === 'all' ? 'ON' : 'OFF',
  };
  const set = (id, side, value) => {
    // A bare id covers both sides; an id already carrying a side covers only that one.
    if (id.endsWith('_IMPORTER') || id.endsWith('_EXPORTER')) vars[`ASSIMP_BUILD_${id}`] = value;
    else vars[`ASSIMP_BUILD_${id}_${side}`] = value;
  };
  if (importers !== 'all') for (const id of importers) set(id, 'IMPORTER', 'ON');
  if (exporters !== 'all') for (const id of exporters) set(id, 'EXPORTER', 'ON');
  for (const id of spec.enable ?? []) set(id, 'IMPORTER', 'ON');
  for (const id of variants.disable.ids) {
    if (id.endsWith('_IMPORTER') || id.endsWith('_EXPORTER')) vars[`ASSIMP_BUILD_${id}`] = 'OFF';
    else {
      vars[`ASSIMP_BUILD_${id}_IMPORTER`] = 'OFF';
      vars[`ASSIMP_BUILD_${id}_EXPORTER`] = 'OFF';
    }
  }
  return Object.fromEntries(
    Object.keys(vars)
      .sort()
      .map((key) => [key, vars[key]]),
  );
}

const names = Object.keys(variants.variants);

const presets = {
  version: 6,
  configurePresets: [
    ...names.map((name) => ({
      name: `wasm-${name}`,
      displayName: `wasm ${name}`,
      generator: 'Ninja',
      binaryDir: '${sourceDir}/build/wasm-' + name,
      cacheVariables: {
        CMAKE_BUILD_TYPE: 'Release',
        LIBASSIMP_VARIANT: name,
        CMAKE_C_COMPILER_LAUNCHER: 'ccache',
        CMAKE_CXX_COMPILER_LAUNCHER: 'ccache',
        ...Object.fromEntries(Object.entries(variants.cacheVariables).filter(([key]) => key !== '$comment')),
        ...variantCacheVariables(name),
      },
    })),
    {
      name: 'native-test',
      displayName: 'native ctest',
      generator: 'Ninja',
      binaryDir: '${sourceDir}/build/native-test',
      cacheVariables: {
        CMAKE_BUILD_TYPE: 'Release',
        LIBASSIMP_VARIANT: 'native-test',
        LIBASSIMP_NATIVE_TESTS: 'ON',
        CMAKE_C_COMPILER_LAUNCHER: 'ccache',
        CMAKE_CXX_COMPILER_LAUNCHER: 'ccache',
        ...Object.fromEntries(
          Object.entries(variants.cacheVariables).filter(
            // lib3mf is an import-side FetchContent dependency; the ctest leg has to stay cheap.
            // The vendored zlib takes a MACOS branch in zutil.h that no longer compiles against
            // the macOS SDK, and every host that runs this preset already ships zlib.
            ([key]) => key !== '$comment' && key !== 'ASSIMP_BUILD_3MF_LIB3MF' && key !== 'ASSIMP_BUILD_ZLIB',
          ),
        ),
        ASSIMP_BUILD_3MF_LIB3MF: 'OFF',
        ASSIMP_BUILD_ZLIB: 'OFF',
        ...variantCacheVariables('native-test'),
      },
    },
  ],
  buildPresets: [
    ...names.map((name) => ({ name: `wasm-${name}`, configurePreset: `wasm-${name}` })),
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
