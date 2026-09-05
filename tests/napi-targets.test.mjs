import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTriple as parseTripleWithCli } from '@napi-rs/cli';

import { parseTriple, readNapiTargets } from '../scripts/lib/napi-targets.mjs';

const path = new URL('../package.json', import.meta.url);

describe('NAPI-RS target spelling', () => {
  it('matches the pinned CLI for every configured package', () => {
    const { packages } = readNapiTargets(path);
    assert.equal(packages.length, 3);
    for (const { triple } of packages) {
      const { abi, arch, platform, platformArchABI } = parseTripleWithCli(triple);
      assert.deepEqual(parseTriple(triple), { abi, arch, platform, platformArchABI, triple });
    }
  });
});
