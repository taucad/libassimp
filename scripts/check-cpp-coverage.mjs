// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testBinary = process.env.LIBASSIMP_TEST_BINARY;
const addon = process.env.LIBASSIMP_NATIVE_ADDON;
const configuredDirectory = process.env.LIBASSIMP_COVERAGE_DIR;
assert(testBinary && configuredDirectory, 'LIBASSIMP_TEST_BINARY and LIBASSIMP_COVERAGE_DIR are required');
const directory = resolve(root, configuredDirectory);

const findTool = (name, configured) => {
  if (configured) return configured;
  const result =
    process.platform === 'darwin'
      ? spawnSync('xcrun', ['--find', name], { encoding: 'utf8' })
      : spawnSync(process.env.CC ?? 'clang', [`-print-prog-name=${name}`], { encoding: 'utf8' });
  const candidate = result.stdout?.trim();
  return result.status === 0 && candidate ? candidate : name;
};
const profdata = findTool('llvm-profdata', process.env.LLVM_PROFDATA);
const cov = findTool('llvm-cov', process.env.LLVM_COV);
const run = (command, arguments_, { capture = false, environment = process.env } = {}) => {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    env: environment,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, capture ? result.stderr : `${command} failed`);
  return result.stdout;
};

mkdirSync(directory, { recursive: true });
rmSync(resolve(directory, 'default.profdata'), { force: true });
for (const name of readdirSync(directory)) {
  if (name.endsWith('.profraw')) rmSync(resolve(directory, name));
}
const profile = resolve(directory, '%p-%m.profraw');
const environment = { ...process.env, LLVM_PROFILE_FILE: profile };
const testArguments = process.env.LIBASSIMP_GTEST_FILTER
  ? [`--gtest_filter=${process.env.LIBASSIMP_GTEST_FILTER}`]
  : [];
run(testBinary, testArguments, { environment });
if (addon) {
  run('node', [resolve(root, 'src/cpp/node-addon.test.mjs')], {
    environment: {
      ...environment,
      LIBASSIMP_NATIVE_ADDON: addon,
      LIBASSIMP_RECORD_CPP_DIAGNOSTICS: '1',
      UV_THREADPOOL_SIZE: '2',
    },
  });
  run('node', [resolve(root, 'tests/native-rpc-cycle.mjs'), '--require-counters'], {
    environment: { ...environment, NAPI_RS_NATIVE_LIBRARY_PATH: addon },
  });
}
const merged = resolve(directory, 'default.profdata');
const profiles = readdirSync(directory)
  .filter((name) => name.endsWith('.profraw'))
  .map((name) => resolve(directory, name));
assert(profiles.length > 0, 'instrumented tests produced no .profraw files');
run(profdata, ['merge', '-sparse', ...profiles, '-o', merged]);

const objects = addon ? ['-object', addon] : [];
const sources = ['libassimp.cpp', 'libassimp.hpp', 'memory-io.hpp'].map((name) =>
  resolve(root, 'src/cpp', name),
);
if (addon) sources.push(resolve(root, 'src/cpp/node-addon.cpp'));
const report = JSON.parse(
  run(cov, ['export', '-summary-only', testBinary, ...objects, `-instr-profile=${merged}`, ...sources], {
    capture: true,
  }),
);
const totals = report.data[0].totals;
for (const metric of ['lines', 'functions', 'regions', 'branches']) {
  assert.equal(
    totals[metric].percent,
    100,
    `C++ ${metric} coverage is ${totals[metric].percent}%, expected 100%`,
  );
}
