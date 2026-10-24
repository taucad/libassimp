#!/usr/bin/env node
// Turns format-matrix reports (bench/matrix.mjs) into a base-versus-PR delta table.
//
//   node bench/matrix-report.mjs [--markdown out.md] [--fail-on-crash] <report.json | name=report.json>...
//
// Reports for the same backend and tier (shards) are merged. A report that
// holds both builds is used as is; `base=a.json pr=b.json` renames the single
// build of each file, so two separate local runs compare too.
//
// The table is report-only. With --fail-on-crash the exit status is non-zero
// when a PR cell crashed (a signal, a non-AssimpError throw, a non-zero exit or
// a timeout) and the same cell on the base did not.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { TIMESTAMPED } from '../tests/format-fixtures.mjs';

export const MARKER = '<!-- libassimp-format-matrix -->';
// Origin: GitHub rejects comment bodies over 65,536 characters.
const COMMENT_LIMIT = 60_000;
// A time change is reported only when the two builds' runs do not overlap and
// the slower median is at least the tier's factor times the faster one and
// at least its milliseconds above it.
// Origin: the A/A run on PR #53 (base and PR on the same engine, ubuntu-24.04)
// stayed within 6.2% on every large cell, while small Wasm cells of 2-20 ms
// swung by up to 2.3x and 11.4 ms with separated runs, because V8 tiers each
// fresh process's code up at a different moment. Small-tier time is therefore
// flagged only beyond that noise; its heap, output and status columns carry
// the signal, and the helical gear covers real-model time in the large tier.
const TIME_THRESHOLDS = { small: { factor: 2.5, ms: 15 }, large: { factor: 1.1, ms: 3 } };
const SIGNIFICANT_CELLS = 30;

const mb = (bytes) => (bytes == null ? '–' : (bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 2 : 1));
const ms = (value) =>
  value == null ? '–' : value < 10 ? value.toFixed(2) : value < 1_000 ? value.toFixed(1) : value.toFixed(0);
const times = (value) => (value == null ? '–' : value.toFixed(2));
const percent = (before, after) => {
  if (before == null || after == null || before === 0) return '';
  const change = ((after - before) / before) * 100;
  return ` (${change >= 0 ? '+' : ''}${change.toFixed(Math.abs(change) < 10 ? 1 : 0)}%)`;
};
const pair = (format, before, after) =>
  before === after || (before != null && after != null && format(before) === format(after))
    ? format(after)
    : `${format(before)} → ${format(after)}${percent(before, after)}`;

/** Loads reports and returns cells keyed by backend, tier and cell id, with each build's result. */
export const mergeReports = (entries) => {
  const groups = new Map();
  for (const { report, rename } of entries) {
    assert.equal(report.schema, 'libassimp-format-matrix-v1', 'not a format-matrix report');
    const names = Object.keys(report.builds);
    if (rename !== undefined) assert.equal(names.length, 1, `${rename}= needs a report with one build`);
    const alias = (name) => rename ?? name;
    const key = `${report.backend}|${report.tier}`;
    if (!groups.has(key)) {
      groups.set(key, {
        backend: report.backend,
        tier: report.tier,
        builds: {},
        cells: new Map(),
        durationMs: 0,
        runs: report.runs,
        side: report.side,
      });
    }
    const group = groups.get(key);
    group.durationMs = Math.max(group.durationMs, report.durationMs);
    for (const name of names) group.builds[alias(name)] ??= report.builds[name];
    for (const cell of report.cells) {
      const merged = group.cells.get(cell.id) ?? { id: cell.id, from: cell.from, to: cell.to, results: {} };
      for (const [name, result] of Object.entries(cell.results)) merged.results[alias(name)] = result;
      group.cells.set(cell.id, merged);
    }
  }
  return [...groups.values()].toSorted((left, right) =>
    `${left.tier}|${left.backend}`.localeCompare(`${right.tier}|${right.backend}`),
  );
};

/** Classifies one cell's base-to-PR change. */
export const compareCell = (base, pr, { to, tier = 'large' } = {}) => {
  const change = { status: `${base?.status ?? 'absent'} → ${pr?.status ?? 'absent'}` };
  change.newCrash = pr?.status === 'crash' && base?.status !== 'crash';
  change.statusChanged = base?.status !== pr?.status;
  if (base?.status !== 'ok' || pr?.status !== 'ok') return change;
  const delta = (pr.medianMs - base.medianMs) / base.medianMs;
  const separated = pr.minMs > base.maxMs || pr.maxMs < base.minMs;
  change.timeDelta = delta;
  change.time =
    separated &&
    Math.max(pr.medianMs, base.medianMs) >=
      Math.min(pr.medianMs, base.medianMs) * TIME_THRESHOLDS[tier].factor &&
    Math.abs(pr.medianMs - base.medianMs) >= TIME_THRESHOLDS[tier].ms
      ? delta > 0
        ? 'slower'
        : 'faster'
      : 'same';
  // Within one process the timestamp rarely ticks, so a stable hash alone does not prove determinism.
  change.fingerprint =
    TIMESTAMPED.has(to) || !base.stable || !pr.stable
      ? 'varies'
      : base.sha256 === pr.sha256
        ? 'same'
        : 'changed';
  return change;
};

/** Peak memory the cell itself added: absolute in a child per cell, growth over the starting RSS otherwise. */
const rssOf = (result, tier) =>
  result?.status !== 'ok'
    ? null
    : tier === 'small'
      ? result.peakRssBytes - result.startRssBytes
      : result.peakRssBytes;

const summarize = (group, baseName, prName) => {
  const rows = [...group.cells.values()].map((cell) => ({
    cell,
    base: cell.results[baseName],
    pr: cell.results[prName],
    change: compareCell(cell.results[baseName], cell.results[prName], { to: cell.to, tier: group.tier }),
  }));
  const count = (predicate) => rows.filter(predicate).length;
  const sum = (pick) =>
    rows.reduce((total, row) => total + (row.change.time === undefined ? 0 : pick(row)), 0);
  return {
    rows,
    cells: rows.length,
    ok: count(({ pr }) => pr?.status === 'ok'),
    slower: count(({ change }) => change.time === 'slower'),
    faster: count(({ change }) => change.time === 'faster'),
    fingerprints: count(({ change }) => change.fingerprint === 'changed'),
    statusChanges: count(({ change }) => change.statusChanged),
    crashes: count(({ pr }) => pr?.status === 'crash'),
    newCrashes: rows.filter(({ change }) => change.newCrash),
    baseMs: sum(({ base }) => base.medianMs),
    prMs: sum(({ pr }) => pr.medianMs),
  };
};

const cellTable = (rows, tier, backend) => {
  const wasm = backend === 'wasm';
  const lines = [
    `| cell | wall ms | × gear | ${wasm ? 'Wasm heap MB | ' : ''}${tier === 'small' ? 'RSS growth MB' : 'peak RSS MB'} | output MB | output |`,
    `| --- | --- | --- | ${wasm ? '--- | ' : ''}--- | --- | --- |`,
  ];
  for (const { cell, base, pr, change } of rows) {
    if (change.time === undefined) {
      lines.push(
        `| ${cell.id} | ${change.status}${pr?.code ? ` (${pr.code})` : base?.code ? ` (${base.code})` : ''} |${wasm ? ' |' : ''} | | | |`,
      );
      continue;
    }
    const flag = change.time === 'same' ? '' : ` **${change.time}**`;
    lines.push(
      `| ${cell.id} | ${pair(ms, base.medianMs, pr.medianMs)}${flag} | ${pair(times, base.ratio, pr.ratio)} | ` +
        `${wasm ? `${pair(mb, base.wasmHeapBytes, pr.wasmHeapBytes)} | ` : ''}${pair(mb, rssOf(base, tier), rssOf(pr, tier))} | ` +
        `${pair(mb, base.outputBytes, pr.outputBytes)} | ${change.fingerprint} |`,
    );
  }
  return lines.join('\n');
};

/** Small-tier rows grouped by source format: sums of medians and the largest memory figures. */
const formatTable = (rows, backend) => {
  const wasm = backend === 'wasm';
  const byFormat = new Map();
  for (const row of rows) {
    if (!byFormat.has(row.cell.from)) byFormat.set(row.cell.from, []);
    byFormat.get(row.cell.from).push(row);
  }
  const max = (values) =>
    values.some((value) => value != null) ? Math.max(...values.filter((value) => value != null)) : null;
  const lines = [
    `| import | cells ok | wall ms (sum) | slower / faster | ${wasm ? 'max Wasm heap MB | ' : ''}max RSS growth MB | output changed | status changed |`,
    `| --- | --- | --- | --- | ${wasm ? '--- | ' : ''}--- | --- | --- |`,
  ];
  for (const [format, group] of byFormat) {
    const compared = group.filter(({ change }) => change.time !== undefined);
    const total = (pick) => compared.reduce((sum, row) => sum + pick(row), 0);
    lines.push(
      `| ${format} | ${group.filter(({ pr }) => pr?.status === 'ok').length}/${group.length} | ` +
        `${pair(
          ms,
          total(({ base }) => base.medianMs),
          total(({ pr }) => pr.medianMs),
        )} | ` +
        `${group.filter(({ change }) => change.time === 'slower').length} / ${group.filter(({ change }) => change.time === 'faster').length} | ` +
        `${wasm ? `${pair(mb, max(group.map(({ base }) => base?.wasmHeapBytes)), max(group.map(({ pr }) => pr?.wasmHeapBytes)))} | ` : ''}` +
        `${pair(mb, max(group.map(({ base }) => rssOf(base, 'small'))), max(group.map(({ pr }) => rssOf(pr, 'small'))))} | ` +
        `${group.filter(({ change }) => change.fingerprint === 'changed').length} | ${group.filter(({ change }) => change.statusChanged).length} |`,
    );
  }
  return lines.join('\n');
};

const short = (build) => (build?.rev ? `\`${build.rev.slice(0, 7)}\`` : '');

/** Renders the delta table for every backend and tier. */
export const renderMarkdown = (groups, { baseName = 'base', prName = 'pr' } = {}) => {
  const summaries = groups.map((group) => ({ group, summary: summarize(group, baseName, prName) }));
  const anyGroup = groups[0];
  const out = [
    MARKER,
    '### Format matrix',
    '',
    `Report-only: only a new crash fails this check. ${baseName} ${short(anyGroup?.builds[baseName])} against ${prName} ${short(anyGroup?.builds[prName])}, ` +
      'both measured on the same runner with their runs interleaved. Wall time is the median of the timed runs; ' +
      `a cell is **slower** or **faster** only when the two builds' runs do not overlap and the medians differ by at least ${TIME_THRESHOLDS.large.factor}x and ${TIME_THRESHOLDS.large.ms} ms ` +
      `(small tier: ${TIME_THRESHOLDS.small.factor}x and ${TIME_THRESHOLDS.small.ms} ms, where V8 tier-up timing dominates). ` +
      '"× gear" divides by the same build\'s helical-gear GLB round trip. "output" compares a SHA-256 over every output file ("varies" marks exporters that stamp the time). ' +
      'Small-tier RSS is the growth over the RSS the cell started from; large-tier RSS is the peak of a process that ran only that cell.',
    '',
    '| tier | backend | cells | ok | slower | faster | output changed | status changed | crashes (new) | wall ms (sum of medians) | job time |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { group, summary } of summaries) {
    out.push(
      `| ${group.tier}${group.side ? ` (${group.side}²)` : ''} | ${group.backend} | ${summary.cells} | ${summary.ok} | ${summary.slower} | ${summary.faster} | ` +
        `${summary.fingerprints} | ${summary.statusChanges} | ${summary.crashes} (${summary.newCrashes.length}) | ${pair(ms, summary.baseMs, summary.prMs)} | ` +
        `${Math.round(group.durationMs / 1_000)} s |`,
    );
  }
  for (const { group, summary } of summaries) {
    out.push('', `#### ${group.tier}, ${group.backend}`, '');
    const calibration = (name) => group.builds[name]?.calibration?.medianMs;
    out.push(
      `Calibration (helical gear GLB → GLB): ${pair(ms, calibration(baseName), calibration(prName))} ms.`,
      '',
    );
    if (summary.newCrashes.length > 0) {
      out.push(
        `**New crashes:** ${summary.newCrashes.map(({ cell, pr }) => `${cell.id} (${pr.message})`).join('; ')}`,
        '',
      );
    }
    const known = summary.rows.filter(({ base, pr }) => base?.status === 'crash' && pr?.status === 'crash');
    if (known.length > 0) {
      out.push(`Crashes in both builds: ${known.map(({ cell }) => cell.id).join(', ')}.`, '');
    }
    if (group.tier === 'large') {
      out.push(cellTable(summary.rows, group.tier, group.backend));
      continue;
    }
    const notable = summary.rows
      .filter(
        ({ change }) =>
          change.statusChanged ||
          change.time === 'slower' ||
          change.time === 'faster' ||
          change.fingerprint === 'changed',
      )
      .toSorted(
        (left, right) => Math.abs(right.change.timeDelta ?? 9) - Math.abs(left.change.timeDelta ?? 9),
      );
    if (notable.length > 0) {
      out.push(
        `Changed cells${notable.length > SIGNIFICANT_CELLS ? ` (${SIGNIFICANT_CELLS} of ${notable.length}; all are in the JSON artifact)` : ''}:`,
        '',
      );
      out.push(cellTable(notable.slice(0, SIGNIFICANT_CELLS), group.tier, group.backend), '');
    } else {
      out.push('No cell changed status, output or time.', '');
    }
    out.push(
      '<details><summary>Per import format</summary>',
      '',
      formatTable(summary.rows, group.backend),
      '',
      '</details>',
    );
  }
  let markdown = `${out.join('\n')}\n`;
  if (markdown.length > COMMENT_LIMIT) {
    markdown = `${markdown.slice(0, COMMENT_LIMIT)}\n\n_Truncated; the full report is in the format-matrix artifact._\n`;
  }
  return {
    markdown,
    newCrashes: summaries.flatMap(({ group, summary }) =>
      summary.newCrashes.map(({ cell }) => `${group.backend} ${group.tier}: ${cell.id}`),
    ),
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string', default: 'base' },
      'fail-on-crash': { type: 'boolean', default: false },
      markdown: { type: 'string' },
      pr: { type: 'string', default: 'pr' },
    },
  });
  assert(positionals.length > 0, 'pass at least one format-matrix report');
  const entries = positionals.map((argument) => {
    const match = /^([\w.-]+)=(.+)$/u.exec(argument);
    return { report: JSON.parse(readFileSync(match ? match[2] : argument, 'utf8')), rename: match?.[1] };
  });
  const { markdown, newCrashes } = renderMarkdown(mergeReports(entries), {
    baseName: values.base,
    prName: values.pr,
  });
  if (values.markdown === undefined) process.stdout.write(markdown);
  else writeFileSync(values.markdown, markdown);
  if (values['fail-on-crash'] && newCrashes.length > 0) {
    process.stderr.write(`new crashes: ${newCrashes.join(', ')}\n`);
    process.exit(1);
  }
}
