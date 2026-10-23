#!/usr/bin/env node

// Record `bench/usd.mjs` reports as the baselines for their platform.
//
//   node scripts/record-baselines.mjs <report.json[,report.json]> [baselines.json] --origin "<why>"
//
// Run it on the runner class that gates (CI's ubuntu-24.04 for linux-x64),
// over at least three reports, and say in --origin what moved and why. The
// tolerances in the file are not touched here: changing one is a reviewed
// edit with its own Origin comment.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { foldReports } from './compare-baselines.mjs';

export const recordBaselines = (baselines, report, origin) => {
  if (typeof origin !== 'string' || origin.trim().length === 0) throw new Error('--origin is required');
  const platform = {};
  for (const [workload, backends] of Object.entries(report.workloads)) {
    for (const [backend, sample] of Object.entries(backends)) {
      if (sample.skipped !== undefined) continue;
      platform[workload] ??= {};
      platform[workload][backend] = {
        ratio: sample.ratio,
        medianMs: sample.medianMs,
        ...(sample.memoryBytes === undefined ? {} : { memoryBytes: sample.memoryBytes }),
        maxRssBytes: sample.maxRssBytes,
        outputs: sample.outputs,
      };
    }
  }
  return {
    ...baselines,
    name: report.name,
    platforms: {
      ...baselines.platforms,
      [report.platform]: { origin: `${origin.trim()} (Node ${report.node})`, workloads: platform },
    },
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { origin: { type: 'string' } },
  });
  const [reportPaths, baselinePath = 'bench/baselines.json'] = positionals;
  if (!reportPaths) {
    throw new Error(
      'usage: node scripts/record-baselines.mjs <report.json[,report.json]> [baselines.json] --origin "<why>"',
    );
  }
  const report = foldReports(reportPaths.split(',').map((path) => JSON.parse(readFileSync(path, 'utf8'))));
  const baselines = JSON.parse(readFileSync(baselinePath, 'utf8'));
  writeFileSync(
    baselinePath,
    `${JSON.stringify(recordBaselines(baselines, report, values.origin), null, 2)}\n`,
  );
}
