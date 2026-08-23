#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MARKER = '<!-- libassimp-benchmark -->';

export const compareBenchmark = (current, base) => {
  if (!base || current.name !== base.name) {
    return `${MARKER}\n### Benchmark\n\nNew benchmark: \`${current.name}\` (${current.medianMs} ms median).`;
  }
  if (current.outputBytes !== base.outputBytes || current.outputFnv !== base.outputFnv) {
    return `${MARKER}\n### Benchmark\n\nByte fingerprints changed for \`${current.name}\`.`;
  }

  const change = (current.medianMs - base.medianMs) / base.medianMs;
  const percentage = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
  return `${MARKER}\n### Benchmark\n\n| Benchmark | main | PR | Change |\n| --- | ---: | ---: | ---: |\n| \`${current.name}\` | ${base.medianMs} ms | ${current.medianMs} ms | ${percentage} |\n| \`createAssimp\` | ${base.initMs} ms | ${current.initMs} ms | |`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const currentPath = process.argv[2];
  const basePath = process.argv[3];
  const outputPath = process.argv[4];
  if (!currentPath || !outputPath) {
    throw new Error('usage: node scripts/compare-benchmark.mjs <current.json> <base.json|-> <output.md>');
  }
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const base = basePath && basePath !== '-' ? JSON.parse(readFileSync(basePath, 'utf8')) : undefined;
  const markdown = compareBenchmark(current, base);
  writeFileSync(outputPath, `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
}
