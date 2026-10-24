// The generated security inputs stay in step with their sources: the fuzz seed
// corpus with the adversarial generators, osv-cpp-pins.json with the engine's
// pins, and the release SBOM with every C/C++ component that ships.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { parseFetchContent, parseLockfilePackages } from '../scripts/generate-sbom.mjs';
import { CASES } from './adversarial-cases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = (...args) => execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

describe('fuzz corpus', () => {
  it('matches scripts/generate-fuzz-corpus.mjs', () => {
    expect(() => node('scripts/generate-fuzz-corpus.mjs', '--check')).not.toThrow();
  });
});

describe('adversarial generators', () => {
  it('give every case a unique id and one entry file', () => {
    expect(new Set(CASES.map(({ id }) => id)).size).toBe(CASES.length);
    for (const testCase of CASES.filter(({ family }) => !['truncated', 'garbage'].includes(family))) {
      const { files, to } = testCase.generate('seed');
      expect(files, testCase.id).toHaveLength(1);
      expect(to).toBe('glb');
    }
  });

  it('writes zip bombs whose entry inflates to the declared size and CRC', () => {
    const { files } = CASES.find(({ id }) => id === 'zip-bomb/usdz').generate('seed');
    const bytes = files[0].bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const compressed = view.getUint32(18, true);
    const declared = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const inflated = inflateRawSync(bytes.subarray(30 + nameLength, 30 + nameLength + compressed));
    expect(inflated.length).toBe(declared);
    expect(inflated.length).toBeGreaterThan(compressed * 100);
  });
});

describe('supply chain', () => {
  it('keeps osv-cpp-pins.json current with the engine pins', () => {
    expect(() => node('scripts/generate-sbom.mjs', '--check')).not.toThrow();
  });

  it('parses FetchContent commit and archive pins and rejects branch pins', () => {
    const cmake = [
      'set(LIB_TAG "0123456789abcdef0123456789abcdef01234567")',
      'FetchContent_Declare(lib GIT_REPOSITORY "https://github.com/o/lib" GIT_TAG ${LIB_TAG})',
      'set(ARCHIVE "89abcdef0123456789abcdef0123456789abcdef")',
      'FetchContent_Declare(other_repo URL "https://github.com/o/other/archive/${ARCHIVE}.tar.gz")',
    ].join('\n');
    expect(parseFetchContent(cmake)).toEqual([
      {
        name: 'lib',
        repository: 'https://github.com/o/lib',
        commit: '0123456789abcdef0123456789abcdef01234567',
      },
      {
        name: 'other',
        repository: 'https://github.com/o/other',
        commit: '89abcdef0123456789abcdef0123456789abcdef',
      },
    ]);
    expect(() =>
      parseFetchContent('FetchContent_Declare(x GIT_REPOSITORY https://h/x GIT_TAG master)'),
    ).toThrow(/not a commit/u);
  });

  it('reads the pnpm lockfile packages with their integrity', () => {
    const packages = parseLockfilePackages(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
    expect(packages.length).toBeGreaterThan(100);
    expect(packages.find(({ name }) => name === 'node-addon-api')?.integrity).toMatch(/^sha512-/u);
  });

  it('emits a CycloneDX 1.6 SBOM covering the engine, its pins, vendored code and the toolchain', () => {
    const directory = mkdtempSync(join(tmpdir(), 'libassimp-sbom-'));
    try {
      node('scripts/generate-sbom.mjs', '--out', directory);
      const sbom = JSON.parse(readFileSync(join(directory, 'libassimp.cdx.json'), 'utf8'));
      expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6' });
      expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u);
      const names = new Set(sbom.components.map(({ name }) => name));
      for (const name of [
        'assimp',
        'lightusd',
        'webifc',
        'lib3mf',
        'zlib',
        'pugixml',
        'rapidjson',
        'node-addon-api',
      ]) {
        expect(names.has(name), name).toBe(true);
      }
      expect(sbom.components.find(({ name }) => name === 'node-addon-api').scope).toBe('required');
      expect(sbom.components.some(({ type }) => type === 'platform')).toBe(true);
      // Reproducible for one commit: a second run is byte-identical.
      const first = readFileSync(join(directory, 'libassimp.cdx.json'));
      node('scripts/generate-sbom.mjs', '--out', directory);
      expect(readFileSync(join(directory, 'libassimp.cdx.json')).equals(first)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
