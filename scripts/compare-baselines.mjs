#!/usr/bin/env node

// Gate a `bench/usd.mjs` report against `bench/baselines.json`.
//
//   node scripts/compare-baselines.mjs <report.json[,report.json]> [baselines.json] [output.md]
//
// Several reports are folded first: the best (lowest) timing ratio and the
// highest memory figures, so one noisy run cannot fail the gate and one quiet
// run cannot hide growth. A workload or backend without a recorded baseline is
// admitted and reported; a recorded one that disappears fails. Baselines move
// only through `scripts/record-baselines.mjs`, never to turn a red build green.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- libassimp-usd-baselines -->';

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

const validateSample = (sample, where) => {
  if (typeof sample?.skipped === 'string') return;
  if (
    !Number.isFinite(sample?.ratio) ||
    sample.ratio <= 0 ||
    !isCount(sample.maxRssBytes) ||
    (sample.memoryBytes !== undefined && !isCount(sample.memoryBytes)) ||
    !Array.isArray(sample.outputs) ||
    sample.outputs.length === 0 ||
    !sample.outputs.every(
      ({ name, bytes, fnv }) => typeof name === 'string' && isCount(bytes) && typeof fnv === 'string',
    )
  ) {
    throw new Error(`invalid benchmark sample at ${where}`);
  }
};

export const validateReport = (report) => {
  if (
    typeof report?.name !== 'string' ||
    typeof report.platform !== 'string' ||
    typeof report.workloads !== 'object'
  ) {
    throw new Error('invalid USD benchmark report');
  }
  for (const [workload, backends] of Object.entries(report.workloads)) {
    for (const [backend, sample] of Object.entries(backends))
      validateSample(sample, `${workload}/${backend}`);
  }
};

const sameOutputs = (left, right) =>
  left.length === right.length &&
  left.every(
    (output, index) =>
      output.name === right[index].name &&
      output.bytes === right[index].bytes &&
      output.fnv === right[index].fnv,
  );

/** Fold repeated reports of one revision into one. */
export const foldReports = (reports) => {
  if (reports.length === 0) throw new Error('at least one report is required');
  reports.forEach(validateReport);
  const [first] = reports;
  const workloads = {};
  for (const [workload, backends] of Object.entries(first.workloads)) {
    workloads[workload] = {};
    for (const [backend, sample] of Object.entries(backends)) {
      const samples = reports.map((report) => report.workloads[workload]?.[backend]);
      if (
        samples.some(
          (other) => other === undefined || (other.skipped === undefined) !== (sample.skipped === undefined),
        )
      ) {
        throw new Error(`reports disagree about ${workload}/${backend}`);
      }
      if (sample.skipped !== undefined) {
        workloads[workload][backend] = sample;
        continue;
      }
      if (!samples.every((other) => sameOutputs(other.outputs, sample.outputs))) {
        throw new Error(
          `output fingerprints differ between runs of ${workload}/${backend}; the conversion is not deterministic`,
        );
      }
      const max = (key) =>
        sample[key] === undefined ? {} : { [key]: Math.max(...samples.map((other) => other[key])) };
      workloads[workload][backend] = {
        ...sample,
        ratio: Math.min(...samples.map((other) => other.ratio)),
        medianMs: Math.min(...samples.map((other) => other.medianMs)),
        ...max('memoryBytes'),
        ...max('maxRssBytes'),
      };
    }
  }
  return { ...first, workloads };
};

const percent = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Compare one folded report with the recorded baselines. */
export const compareBaselines = (report, baselines) => {
  validateReport(report);
  const { tolerance } = baselines;
  const recorded = baselines.platforms?.[report.platform]?.workloads;
  const failures = [];
  const notes = [];
  const rows = [];
  if (report.name !== baselines.name) {
    failures.push(
      `report \`${report.name}\` does not match baselines \`${baselines.name}\`; re-record the baselines`,
    );
  }
  if (recorded === undefined) {
    notes.push(`No baselines recorded for \`${report.platform}\`; the report is admitted without a gate.`);
  }
  // A backend the run did not measure at all (the drift job has no addon) is out of scope, not lost.
  const measured = new Set(Object.values(report.workloads).flatMap((backends) => Object.keys(backends)));
  for (const [workload, backends] of Object.entries(recorded ?? {})) {
    for (const backend of Object.keys(backends).filter((name) => measured.has(name))) {
      if (report.workloads[workload]?.[backend] === undefined)
        failures.push(`${workload}/${backend} has a baseline but was not measured`);
    }
  }
  for (const [workload, backends] of Object.entries(report.workloads)) {
    for (const [backend, sample] of Object.entries(backends)) {
      const base = recorded?.[workload]?.[backend];
      const id = `${workload}/${backend}`;
      if (sample.skipped !== undefined) {
        if (base !== undefined) failures.push(`${id} was skipped (${sample.skipped}) but has a baseline`);
        continue;
      }
      if (base === undefined) {
        if (recorded !== undefined) notes.push(`New workload admitted: \`${id}\`.`);
        rows.push(
          `| \`${id}\` | | ${sample.ratio} | | | ${sample.memoryBytes === undefined ? '' : mib(sample.memoryBytes)} | ${mib(sample.maxRssBytes)} |`,
        );
        continue;
      }
      if (!sameOutputs(sample.outputs, base.outputs)) {
        failures.push(
          `${id} output fingerprints changed; re-record the baselines only when the change is intentional`,
        );
      }
      const ratioChange = sample.ratio / base.ratio - 1;
      if (ratioChange > tolerance.ratio) {
        failures.push(
          `${id} time ratio ${sample.ratio} is ${percent(ratioChange)} over its baseline ${base.ratio} (limit ${percent(tolerance.ratio)})`,
        );
      } else if (ratioChange < -tolerance.ratio) {
        notes.push(
          `\`${id}\` is ${percent(ratioChange)} faster than its baseline; record new baselines to ratchet it.`,
        );
      }
      const memoryLimit = (value, relative, absolute = 0) =>
        Math.max(value * (1 + relative), value + absolute);
      if (base.memoryBytes !== undefined) {
        const limit = memoryLimit(
          base.memoryBytes,
          tolerance.memoryBytes.relative,
          tolerance.memoryBytes.absolute,
        );
        if (sample.memoryBytes === undefined || sample.memoryBytes > limit) {
          failures.push(
            `${id} Wasm memory ${sample.memoryBytes === undefined ? 'unmeasured' : mib(sample.memoryBytes)} exceeds ${mib(limit)} (baseline ${mib(base.memoryBytes)})`,
          );
        }
      }
      const rssLimit = memoryLimit(
        base.maxRssBytes,
        tolerance.maxRssBytes.relative,
        tolerance.maxRssBytes.absolute,
      );
      if (sample.maxRssBytes > rssLimit) {
        failures.push(
          `${id} peak RSS ${mib(sample.maxRssBytes)} exceeds ${mib(rssLimit)} (baseline ${mib(base.maxRssBytes)})`,
        );
      }
      rows.push(
        `| \`${id}\` | ${base.ratio} | ${sample.ratio} | ${percent(ratioChange)} | ${sample.medianMs} ms | ${
          sample.memoryBytes === undefined
            ? ''
            : `${mib(sample.memoryBytes)} (${percent(sample.memoryBytes / base.memoryBytes - 1)})`
        } | ${mib(sample.maxRssBytes)} (${percent(sample.maxRssBytes / base.maxRssBytes - 1)}) |`,
      );
    }
  }
  const markdown = [
    MARKER,
    '### USD baselines',
    '',
    `Platform \`${report.platform}\`. Time is a ratio to the helical-gear calibration conversion in the same process; limit ${percent(tolerance.ratio)}.`,
    '',
    '| Workload | Baseline ratio | Ratio | Change | Median | Wasm memory | Peak RSS |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    ...(notes.length === 0 ? [] : ['', ...notes.map((note) => `- ${note}`)]),
    ...(failures.length === 0 ? [] : ['', '**Failures**', '', ...failures.map((failure) => `- ${failure}`)]),
  ].join('\n');
  return { failed: failures.length > 0, failures, markdown };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reportPaths, baselinePath = 'bench/baselines.json', outputPath] = process.argv.slice(2);
  if (!reportPaths) {
    throw new Error(
      'usage: node scripts/compare-baselines.mjs <report.json[,report.json]> [baselines.json] [output.md]',
    );
  }
  const report = foldReports(reportPaths.split(',').map((path) => JSON.parse(readFileSync(path, 'utf8'))));
  const result = compareBaselines(report, JSON.parse(readFileSync(baselinePath, 'utf8')));
  if (outputPath) writeFileSync(outputPath, `${result.markdown}\n`);
  process.stdout.write(`${result.markdown}\n`);
  if (result.failed) process.exitCode = 1;
}
