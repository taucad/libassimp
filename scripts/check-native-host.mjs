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

// The hardening CMakeLists.txt asks for, read back from the binary: full RELRO
// (a GNU_RELRO segment plus BIND_NOW), a non-executable stack, stack-protector
// canaries, and _FORTIFY_SOURCE's checked libc calls.
export const elfHardening = ({ dynamic, programHeaders, symbols }) => {
  const findings = [];
  if (!/^\s*GNU_RELRO\b/mu.test(programHeaders)) findings.push('no GNU_RELRO segment');
  if (!/\(FLAGS\)\s.*\bBIND_NOW\b|\(FLAGS_1\)\s.*\bNOW\b/mu.test(dynamic))
    findings.push('lazy binding (no BIND_NOW)');
  if (/^\s*GNU_STACK\b.*\bRWE\b/mu.test(programHeaders)) findings.push('executable stack');
  if (!/\b__stack_chk_fail\b/u.test(symbols)) findings.push('no stack protector (__stack_chk_fail)');
  if (!/\b__(?!stack_chk_fail)\w+_chk\b/u.test(symbols))
    findings.push('no _FORTIFY_SOURCE checked calls (__*_chk)');
  return findings;
};

export const peHardening = (headers) =>
  /Control Flow Guard/u.test(headers) ? [] : ['no Control Flow Guard (/guard:cf)'];

export const machoHardening = (symbols) =>
  /\b___stack_chk_fail\b/u.test(symbols) ? [] : ['no stack protector (___stack_chk_fail)'];

const inspectLinux = () => {
  const versions = run('readelf', ['--version-info', binary]);
  const glibc = maxGlibcVersion(versions);
  const glibcxx = maxGlibcxxVersion(versions);
  const cxxabi = maxCxxabiVersion(versions);
  assert(glibc, 'native addon has no versioned glibc dependency');
  assert(compareVersions(glibc, '2.17') <= 0, `native addon requires GLIBC_${glibc}, above GLIBC_2.17`);
  // libstdc++ is linked in statically so that mimalloc serves every C++
  // allocation the addon frees (CMakeLists.txt); a shared one would mix heaps.
  assert.equal(glibcxx, undefined, `native addon requires GLIBCXX_${glibcxx} from a shared libstdc++`);
  assert.equal(cxxabi, undefined, `native addon requires CXXABI_${cxxabi} from a shared libstdc++`);
  const dynamic = run('readelf', ['--dynamic', binary]);
  const dependencies = elfDependencies(dynamic);
  checkElfDependencies(dependencies);
  const hardening = elfHardening({
    dynamic,
    programHeaders: run('readelf', ['--program-headers', '--wide', binary]),
    symbols: run('readelf', ['--dyn-syms', '--wide', binary]),
  });
  assert.deepEqual(hardening, [], `native addon hardening: ${hardening.join(', ')}`);
  return { dependencies, glibc, hardening: 'full RELRO, NX stack, SSP, FORTIFY', libstdcxx: 'static' };
};

export const checkElfDependencies = (dependencies) => {
  // The glibc 2.17 floor provides pthread separately for the owned executor.
  // Platform library list: https://peps.python.org/pep-0599/#the-manylinux2014-policy
  const allowed = new Set([
    'ld-linux-x86-64.so.2',
    'libc.so.6',
    'libgcc_s.so.1',
    'libm.so.6',
    'libpthread.so.0',
    'librt.so.1',
  ]);
  assert.deepEqual(
    dependencies.filter((dependency) => !allowed.has(dependency)),
    [],
    `unexpected ELF dependencies: ${dependencies.join(', ')}`,
  );
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
  const hardening = machoHardening(run('nm', ['-u', binary]));
  assert.deepEqual(hardening, [], `native addon hardening: ${hardening.join(', ')}`);
  return { dependencies, minimum: '11.0', hardening: 'SSP' };
};

const inspectWindows = () => {
  const dependencies = run('dumpbin', ['/nologo', '/dependents', binary])
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.endsWith('.dll'))
    .toSorted((left, right) => left.localeCompare(right));
  const allowed = new Set(['advapi32.dll', 'kernel32.dll', 'node.exe', 'ole32.dll', 'ucrtbase.dll']);
  assert.deepEqual(
    dependencies.filter(
      (dependency) => !allowed.has(dependency) && !dependency.startsWith('api-ms-win-crt-'),
    ),
    [],
    `unexpected PE dependencies: ${dependencies.join(', ')}`,
  );
  const hardening = peHardening(run('dumpbin', ['/nologo', '/headers', binary]));
  assert.deepEqual(hardening, [], `native addon hardening: ${hardening.join(', ')}`);
  return { dependencies, hardening: 'CFG' };
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
