#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const THRESHOLD = 0.1;
const MARKER = '<!-- libassimp-benchmark -->';

const validateBenchmark = (report) => {
  if (
    typeof report?.name !== 'string' ||
    report.name.length === 0 ||
    !Number.isFinite(report.medianMs) ||
    report.medianMs < 0 ||
    !Number.isFinite(report.initMs) ||
    report.initMs < 0 ||
    !Number.isSafeInteger(report.outputBytes) ||
    report.outputBytes < 0 ||
    typeof report.outputFnv !== 'string' ||
    report.outputFnv.length === 0
  ) {
    throw new Error('invalid benchmark report');
  }
};

export const averageBenchmarks = (reports) => {
  if (reports.length === 0) throw new Error('at least one benchmark report is required');
  reports.forEach(validateBenchmark);
  const [first] = reports;
  for (const report of reports.slice(1)) {
    if (
      report.name !== first.name ||
      report.outputBytes !== first.outputBytes ||
      report.outputFnv !== first.outputFnv
    ) {
      throw new Error('cannot average benchmark reports with different identities or output fingerprints');
    }
  }
  const average = (key) =>
    Math.round((reports.reduce((sum, report) => sum + report[key], 0) / reports.length) * 1_000) / 1_000;
  return { ...first, medianMs: average('medianMs'), initMs: average('initMs') };
};

export const compareBenchmark = (current, base) => {
  validateBenchmark(current);
  if (base !== undefined) validateBenchmark(base);
  if (base === undefined || current.name !== base.name) {
    return {
      failed: false,
      markdown: `${MARKER}\n### Benchmark\n\nNew benchmark admitted: \`${current.name}\` (${current.medianMs} ms median).`,
    };
  }
  if (current.outputBytes !== base.outputBytes || current.outputFnv !== base.outputFnv) {
    return {
      failed: true,
      markdown: `${MARKER}\n### Benchmark\n\nByte fingerprints changed for \`${current.name}\`. Rename the benchmark only when the semantic change is intentional.`,
    };
  }

  const change = (current.medianMs - base.medianMs) / base.medianMs;
  const percentage = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
  return {
    failed: change > THRESHOLD,
    markdown: `${MARKER}\n### Benchmark\n\n| Benchmark | main | PR | Change | Limit |\n| --- | ---: | ---: | ---: | ---: |\n| \`${current.name}\` | ${base.medianMs} ms | ${current.medianMs} ms | ${percentage} | +10.0% |\n| \`createAssimp\` | ${base.initMs} ms | ${current.initMs} ms | | |`,
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const currentPath = process.argv[2];
  const basePath = process.argv[3];
  const outputPath = process.argv[4];
  if (!currentPath || !outputPath) {
    throw new Error(
      'usage: node scripts/compare-benchmark.mjs <current.json[,current.json]> <base.json[,base.json]|-> <output.md>',
    );
  }
  const readReports = (paths) =>
    averageBenchmarks(paths.split(',').map((path) => JSON.parse(readFileSync(path, 'utf8'))));
  const current = readReports(currentPath);
  const base = basePath && basePath !== '-' ? readReports(basePath) : undefined;
  const result = compareBenchmark(current, base);
  writeFileSync(outputPath, `${result.markdown}\n`);
  process.stdout.write(`${result.markdown}\n`);
  if (result.failed) process.exitCode = 1;
}
