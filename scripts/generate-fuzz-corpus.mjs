// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

// Write the libFuzzer seed corpus for tests/fuzz/plan-fuzzer.cpp.
//
//   node scripts/generate-fuzz-corpus.mjs           rewrite tests/fuzz/corpus
//   node scripts/generate-fuzz-corpus.mjs --check   fail if the corpus is stale
//
// Seeds are the adversarial cases at their small 'seed' scale (64-deep
// nesting, 4 MiB archive and stream bombs) plus the valid engine fixtures the
// truncation cases start from, each prefixed with the harness header
// "<extension> <target>\n". Every seed stays under MAX_SEED_BYTES so the
// corpus can live in git; the full-size inputs exist only at test time.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, TRUNCATION_FIXTURES, loadFixture } from '../tests/adversarial-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = join(root, 'tests', 'fuzz', 'corpus');
const MAX_SEED_BYTES = 64 * 1024;

const header = (name, to) => {
  const lower = name.toLowerCase();
  const extension = lower.endsWith('.mesh.xml') ? 'mesh.xml' : extname(lower).slice(1);
  return new TextEncoder().encode(`${extension} ${to}\n`);
};

const seed = (name, to, bytes) => {
  const prefix = header(name, to);
  const output = new Uint8Array(prefix.length + bytes.length);
  output.set(prefix);
  output.set(bytes, prefix.length);
  return output;
};

export const seeds = () => {
  const entries = new Map();
  for (const testCase of CASES) {
    if (testCase.family === 'truncated' || testCase.family === 'garbage') continue;
    const { files, to } = testCase.generate('seed');
    const bytes = seed(files[0].name, to, files[0].bytes);
    if (bytes.length <= MAX_SEED_BYTES) entries.set(testCase.id.replaceAll('/', '--'), bytes);
  }
  // models-nonbsd carries licenses other than assimp's BSD terms, so those
  // fixtures are read at test time but never copied into this repository.
  for (const relative of TRUNCATION_FIXTURES.filter((path) => !path.includes('models-nonbsd'))) {
    const { name, bytes } = loadFixture(relative);
    const output = seed(name, 'glb', bytes);
    if (output.length <= MAX_SEED_BYTES) entries.set(`fixture--${basename(name).toLowerCase()}`, output);
  }
  return entries;
};

const main = () => {
  const expected = seeds();
  if (process.argv[2] === '--check') {
    const present = existsSync(corpus) ? readdirSync(corpus) : [];
    const names = [...expected.keys()];
    const stale = names.filter(
      (name) => !present.includes(name) || !readFileSync(join(corpus, name)).equals(expected.get(name)),
    );
    const extra = present.filter((name) => !expected.has(name));
    if (stale.length > 0 || extra.length > 0) {
      throw new Error(
        `tests/fuzz/corpus is stale (${[...stale, ...extra].join(', ')}): run node scripts/generate-fuzz-corpus.mjs`,
      );
    }
    return;
  }
  rmSync(corpus, { recursive: true, force: true });
  mkdirSync(corpus, { recursive: true });
  for (const [name, bytes] of expected) writeFileSync(join(corpus, name), bytes);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
