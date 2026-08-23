import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { variantCacheVariables, variants } from '../scripts/variants-to-presets.mjs';

const presetsPath = fileURLToPath(new URL('../CMakePresets.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/variants-to-presets.mjs', import.meta.url));

describe('variants-to-presets', () => {
  it('regenerating CMakePresets.json is a no-op', () => {
    const before = readFileSync(presetsPath, 'utf8');
    execFileSync(process.execPath, [scriptPath]);
    expect(readFileSync(presetsPath, 'utf8')).toBe(before);
  });

  it('gives every variant a configure, build and test entry point', () => {
    const presets = JSON.parse(readFileSync(presetsPath, 'utf8'));
    const names = [...Object.keys(variants.variants).map((name) => `wasm-${name}`), 'native-test'];
    expect(presets.configurePresets.map((preset) => preset.name)).toEqual(names);
    expect(presets.buildPresets.map((preset) => preset.configurePreset)).toEqual(names);
    expect(presets.testPresets.map((preset) => preset.configurePreset)).toEqual(['native-test']);
  });

  it('disables every format on the shared disable list, whichever variant asked for it', () => {
    for (const name of Object.keys(variants.variants)) {
      const cacheVariables = variantCacheVariables(name);
      for (const id of variants.disable.ids) {
        const keys =
          id.endsWith('_IMPORTER') || id.endsWith('_EXPORTER')
            ? [`ASSIMP_BUILD_${id}`]
            : [`ASSIMP_BUILD_${id}_IMPORTER`, `ASSIMP_BUILD_${id}_EXPORTER`];
        for (const key of keys) expect(cacheVariables[key], `${name}/${key}`).toBe('OFF');
      }
    }
  });

  it('turns the by-default switches on only for the side a variant compiles whole', () => {
    expect(variantCacheVariables('full')).toMatchObject({
      ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT: 'ON',
      ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT: 'ON',
      ASSIMP_BUILD_USD_IMPORTER: 'ON',
    });
    expect(variantCacheVariables('exporter')).toMatchObject({
      ASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT: 'OFF',
      ASSIMP_BUILD_ALL_EXPORTERS_BY_DEFAULT: 'ON',
      ASSIMP_BUILD_GLTF_IMPORTER: 'ON',
      ASSIMP_BUILD_USD_IMPORTER: 'ON',
    });
  });
});
