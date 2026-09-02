#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = process.argv[2];

const run = (command, arguments_) => {
  const result = spawnSync(command, arguments_, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const compareVersions = (left, right) => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const maxSymbolVersion = (text, namespace) => {
  const versions = [...text.matchAll(/\b(GLIBC|GLIBCXX|CXXABI)_(\d+(?:\.\d+)+)\b/gu)]
    .filter((match) => match[1] === namespace)
    .map((match) => match[2]);
  return versions.reduce(
    (highest, version) =>
      highest === undefined || compareVersions(version, highest) > 0 ? version : highest,
    undefined,
  );
};

export const maxGlibcVersion = (text) => maxSymbolVersion(text, 'GLIBC');
export const maxGlibcxxVersion = (text) => maxSymbolVersion(text, 'GLIBCXX');
export const maxCxxabiVersion = (text) => maxSymbolVersion(text, 'CXXABI');

export const elfDependencies = (text) =>
  [...text.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/gu)]
    .map((match) => match[1])
    .toSorted((left, right) => left.localeCompare(right));

const inspectLinux = () => {
  const versions = run('readelf', ['--version-info', binary]);
  const glibc = maxGlibcVersion(versions);
  const glibcxx = maxGlibcxxVersion(versions);
  const cxxabi = maxCxxabiVersion(versions);
  assert(glibc, 'native addon has no versioned glibc dependency');
  assert(glibcxx, 'native addon has no versioned libstdc++ dependency');
  assert(cxxabi, 'native addon has no versioned C++ ABI dependency');
  assert(compareVersions(glibc, '2.17') <= 0, `native addon requires GLIBC_${glibc}, above GLIBC_2.17`);
  assert(
    compareVersions(glibcxx, '3.4.19') <= 0,
    `native addon requires GLIBCXX_${glibcxx}, above GLIBCXX_3.4.19`,
  );
  assert(compareVersions(cxxabi, '1.3.7') <= 0, `native addon requires CXXABI_${cxxabi}, above CXXABI_1.3.7`);
  const dependencies = elfDependencies(run('readelf', ['--dynamic', binary]));
  const allowed = new Set(['libc.so.6', 'libgcc_s.so.1', 'libm.so.6', 'libstdc++.so.6']);
  assert.deepEqual(
    dependencies.filter((dependency) => !allowed.has(dependency)),
    [],
    `unexpected ELF dependencies: ${dependencies.join(', ')}`,
  );
  return { cxxabi, dependencies, glibc, glibcxx };
};

const inspectDarwin = () => {
  const commands = run('otool', ['-l', binary]);
  const minimums = [...commands.matchAll(/^\s*minos\s+(\d+(?:\.\d+)*)$/gmu)].map((match) => match[1]);
  assert(minimums.length > 0, 'native addon has no LC_BUILD_VERSION minimum');
  assert(
    minimums.every((version) => version === '11.0'),
    `expected macOS 11.0, found ${minimums.join(', ')}`,
  );
  const dependencies = run('otool', ['-L', binary])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
  assert(
    dependencies.every(
      (dependency) => dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/'),
    ),
    `unexpected Mach-O dependencies: ${dependencies.join(', ')}`,
  );
  return { dependencies, minimum: '11.0' };
};

const inspectWindows = () => {
  const dependencies = run('dumpbin', ['/nologo', '/dependents', binary])
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.endsWith('.dll'))
    .toSorted((left, right) => left.localeCompare(right));
  const allowed = new Set(['kernel32.dll', 'node.exe', 'ucrtbase.dll']);
  assert.deepEqual(
    dependencies.filter(
      (dependency) => !allowed.has(dependency) && !dependency.startsWith('api-ms-win-crt-'),
    ),
    [],
    `unexpected PE dependencies: ${dependencies.join(', ')}`,
  );
  return { dependencies };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(binary, 'usage: node scripts/check-native-host.mjs <addon.node>');
  const inspection =
    process.platform === 'linux'
      ? inspectLinux()
      : process.platform === 'darwin'
        ? inspectDarwin()
        : process.platform === 'win32'
          ? inspectWindows()
          : assert.fail(`unsupported native build host: ${process.platform}`);
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
}
