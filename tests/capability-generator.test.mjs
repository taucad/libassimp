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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  normalizeSourceText,
  resolveOptionDescriptions,
  validateOptionDescription,
  validateOverrideCoverage,
  validateSourceEvidence,
} from '../scripts/generate-assimp-capabilities.mjs';
import { internalExportOptionDescriptors } from '../src/generated/assimp-capabilities.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = JSON.parse(readFileSync(`${root}scripts/assimp-capability-evidence.json`, 'utf8'));
const overrides = JSON.parse(readFileSync(`${root}scripts/assimp-capability-overrides.json`, 'utf8'));
const prose = JSON.parse(readFileSync(`${root}scripts/assimp-option-descriptions.json`, 'utf8'));
const proseFamilies = { formatNames: { stl: 'STL' }, UpAxis: 'Axis that points up in {format} files.' };

describe('capability generator', () => {
  it('hashes Windows and POSIX text identically', () => {
    expect(normalizeSourceText('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  it('generates byte-identical output twice', () => {
    const path = `${root}src/generated/assimp-capabilities.ts`;
    const before = readFileSync(path);
    execFileSync(process.execPath, [`${root}scripts/generate-assimp-capabilities.mjs`, '--check']);
    const first = readFileSync(path);
    execFileSync(process.execPath, [`${root}scripts/generate-assimp-capabilities.mjs`, '--check']);
    expect(first).toEqual(before);
    expect(readFileSync(path)).toEqual(first);
  });

  it('identifies the native key and source when an override is missing', () => {
    const property = evidence.properties[0];
    const changed = structuredClone(overrides);
    delete changed.properties[property.nativeName];
    expect(() => validateOverrideCoverage(evidence, changed)).toThrow(
      `${property.nativeName} observed at ${property.sources.join(', ')}`,
    );
  });

  it('identifies the changed source', () => {
    const path = evidence.sources[0];
    const hashes = { ...evidence.sourceSha256ByPath, [path]: 'changed' };
    expect(() => validateSourceEvidence(evidence, evidence.engineSha, hashes)).toThrow(path);
  });

  it('normalizes route selectors to the internal descriptor contract', () => {
    const selectors = Object.entries(internalExportOptionDescriptors).flatMap(([format, descriptors]) =>
      Object.values(descriptors)
        .filter(({ nativeName }) => nativeName.startsWith('@route/'))
        .map((descriptor) => ({ format, descriptor })),
    );
    expect(selectors).toHaveLength(4);
    for (const { format, descriptor } of selectors) {
      // The root entry ships validator fields only; provenance stays in the evidence.
      expect(descriptor.nativeKind, format).toBe(descriptor.kind);
      expect(Object.keys(descriptor)).not.toContain('formats');
    }
  });

  it('takes option prose only from the handwritten source', () => {
    const resolved = resolveOptionDescriptions(
      {
        families: proseFamilies,
        import: { favourSpeed: 'Trade accuracy for speed.', importFbxReadCameras: null },
        export: { binary: null, pointClouds: { '*': 'Has no effect.', ply: 'Keep vertices.' } },
      },
      [{ publicName: 'favourSpeed' }, { publicName: 'importFbxReadCameras' }, { publicName: 'stlUpAxis' }],
      {
        ply: [{ publicName: 'binary' }, { publicName: 'pointClouds' }],
        stl: [{ publicName: 'binary' }, { publicName: 'pointClouds' }],
      },
    );
    expect(resolved).toEqual({
      import: { favourSpeed: 'Trade accuracy for speed.', stlUpAxis: 'Axis that points up in STL files.' },
      export: { ply: { pointClouds: 'Keep vertices.' }, stl: { pointClouds: 'Has no effect.' } },
    });
  });

  it('names a missing or unknown option description', () => {
    const exportOptions = { stl: [{ publicName: 'binary' }] };
    const families = { ...proseFamilies, formatNames: {} };
    expect(() => resolveOptionDescriptions({ families, import: {}, export: {} }, [], exportOptions)).toThrow(
      'Missing description for stl export option binary',
    );
    expect(() =>
      resolveOptionDescriptions(
        { families, import: { gone: null }, export: { binary: null } },
        [],
        exportOptions,
      ),
    ).toThrow('Unused description for unknown import option gone');
    expect(() =>
      resolveOptionDescriptions(
        { families, import: {}, export: { binary: { ply: null } } },
        [],
        exportOptions,
      ),
    ).toThrow('Missing stl description for export option binary');
  });

  it('rejects prose that names engine internals or breaks sentence style', () => {
    expect(() => validateOptionDescription('x', 'AI_CONFIG_APP_SCALE_KEY.')).toThrow('engine internals');
    expect(() => validateOptionDescription('x', '3MF_EXPORT_UNIT.')).toThrow('engine internals');
    expect(() => validateOptionDescription('x', 'Specifies whether the assimp export shall.')).toThrow(
      'engine internals',
    );
    expect(() => validateOptionDescription('x', 'See the @link perf page.')).toThrow('engine internals');
    expect(() => validateOptionDescription('x', 'write binary files')).toThrow('capital letter');
    expect(() => validateOptionDescription('x', 'Write binary files')).toThrow('full stop');
    expect(() => validateOptionDescription('x', 'Write KHR_materials_specular data.')).not.toThrow();
  });

  it('describes every compiled option in the handwritten source', () => {
    expect(Object.keys(prose.import).length + Object.keys(prose.export).length).toBeGreaterThan(100);
    expect(JSON.stringify(overrides.properties)).not.toContain('"description"');
  });
});
