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
  validateOverrideCoverage,
  validateSourceEvidence,
} from '../scripts/generate-assimp-capabilities.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = JSON.parse(readFileSync(`${root}scripts/assimp-capability-evidence.json`, 'utf8'));
const overrides = JSON.parse(readFileSync(`${root}scripts/assimp-capability-overrides.json`, 'utf8'));

describe('capability generator', () => {
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
});
