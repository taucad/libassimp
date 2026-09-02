import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildCacheVariables, builds } from '../scripts/assimp-builds-to-presets.mjs';

const presetsPath = fileURLToPath(new URL('../CMakePresets.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/assimp-builds-to-presets.mjs', import.meta.url));

describe('assimp-builds-to-presets', () => {
  it('regenerating CMakePresets.json is a no-op', () => {
    const before = readFileSync(presetsPath, 'utf8');
    execFileSync(process.execPath, [scriptPath]);
    expect(readFileSync(presetsPath, 'utf8')).toBe(before);
  });

  it('gives production Wasm, native tests, and production native their exact entry points', () => {
    const presets = JSON.parse(readFileSync(presetsPath, 'utf8'));
    expect(presets.configurePresets.map((preset) => preset.name)).toEqual(['wasm', 'native-test', 'native']);
    expect(presets.buildPresets.map((preset) => preset.configurePreset)).toEqual([
      'wasm',
      'native-test',
      'native',
    ]);
    expect(presets.testPresets.map((preset) => preset.configurePreset)).toEqual(['native-test']);
  });

  it('disables every format on the shared disable list in every build', () => {
    for (const name of ['wasm', 'native-test', 'native']) {
      const cacheVariables = buildCacheVariables(name);
      for (const id of builds.disable.ids) {
        const keys =
          id.endsWith('_IMPORTER') || id.endsWith('_EXPORTER')
            ? [`ASSIMP_BUILD_${id}`]
            : [`ASSIMP_BUILD_${id}_IMPORTER`, `ASSIMP_BUILD_${id}_EXPORTER`];
        for (const key of keys) expect(cacheVariables[key], `${name}/${key}`).toBe('OFF');
      }
    }
  });

  it('builds every admitted production format natively and in Wasm', () => {
    for (const name of ['wasm', 'native']) {
      expect(buildCacheVariables(name)).toMatchObject({
        ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT: 'ON',
        ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT: 'ON',
        ASSIMP_BUILD_USD_IMPORTER: 'ON',
        ASSIMP_BUILD_VRML_IMPORTER: 'ON',
        ASSIMP_BUILD_IFC_IMPORTER: 'ON',
      });
    }
    expect(buildCacheVariables('native-test')).toMatchObject({
      ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT: 'OFF',
      ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT: 'OFF',
      ASSIMP_BUILD_OBJ_IMPORTER: 'ON',
      ASSIMP_BUILD_GLTF_EXPORTER: 'ON',
    });
    const native = JSON.parse(readFileSync(presetsPath, 'utf8')).configurePresets.find(
      ({ name }) => name === 'native-test',
    );
    expect(native.cacheVariables.ASSIMP_BUILD_3MF_LIB3MF).toBe('ON');
  });
});
