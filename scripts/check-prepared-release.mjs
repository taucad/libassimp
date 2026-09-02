#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';
import { validatePackageFiles } from './package-files.mjs';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const platformFindings = ({ directory, rootManifest, target }) => {
  const relative = `npm/${target.suffix}`;
  const path = join(directory, 'package.json');
  if (!existsSync(path)) return [`${target.suffix}: ${relative}/package.json is missing`];
  const manifest = readJson(path);
  const findings = [];
  const note = (message) => findings.push(`${target.suffix}: ${message}`);
  for (const [field, expected] of [
    ['name', target.name],
    ['version', rootManifest.version],
    ['os', [target.os]],
    ['cpu', [target.cpu]],
    ['engines', rootManifest.engines],
    ['files', [target.binary]],
  ]) {
    if (!same(manifest[field], expected)) {
      note(`expected ${field} ${JSON.stringify(expected)}, found ${JSON.stringify(manifest[field])}`);
    }
  }
  if (target.libc ? !same(manifest.libc, [target.libc]) : manifest.libc !== undefined) {
    const selector = target.libc ? `libc ${JSON.stringify([target.libc])}` : 'no libc selector';
    note(`expected ${selector}, found ${JSON.stringify(manifest.libc)}`);
  }
  if (manifest.main !== target.binary) note(`expected main ${target.binary}, found ${manifest.main}`);
  if (manifest.license !== rootManifest.license) {
    note(`expected license ${rootManifest.license}, found ${manifest.license}`);
  }
  if (!existsSync(join(directory, target.binary))) note(`${relative}/${target.binary} is missing`);
  if (!existsSync(join(directory, 'license'))) note(`${relative}/license is missing`);
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
    if (entry.endsWith('.node') && entry !== target.binary) {
      note(`${relative}/${entry} is not the ${target.suffix} binary`);
    }
  }
  return findings;
};

export const preparedReleaseFindings = ({ packedFiles, root }) => {
  const rootDirectory = resolve(root);
  const { manifest, packages } = readNapiTargets(join(rootDirectory, 'package.json'));
  const findings = [];
  const configured = new Set(packages.map(({ suffix }) => suffix));
  const npmDirectory = join(rootDirectory, 'npm');
  for (const entry of existsSync(npmDirectory) ? readdirSync(npmDirectory) : []) {
    if (!configured.has(entry)) findings.push(`npm/${entry} is not a configured target package`);
  }
  for (const target of packages) {
    findings.push(
      ...platformFindings({
        directory: join(npmDirectory, target.suffix),
        rootManifest: manifest,
        target,
      }),
    );
  }
  const expected = new Map(packages.map(({ name }) => [name, manifest.version]));
  const declared = manifest.optionalDependencies ?? {};
  for (const [name, version] of expected) {
    if (!(name in declared)) findings.push(`root optionalDependencies: ${name} is missing`);
    else if (declared[name] !== version) {
      findings.push(`root optionalDependencies: expected ${name}@${version}, found ${declared[name]}`);
    }
  }
  for (const name of Object.keys(declared)) {
    if (!expected.has(name)) {
      findings.push(`root optionalDependencies: ${name} is not a configured target package`);
    }
  }
  if (!existsSync(join(rootDirectory, 'dist/native/index.js'))) {
    findings.push('dist/native/index.js is missing');
  }
  for (const file of packedFiles.filter((entry) => entry.endsWith('.node'))) {
    findings.push(`root pack: ${file} is a native binary`);
  }
  try {
    validatePackageFiles(packedFiles);
  } catch (error) {
    findings.push(`root pack: ${error instanceof Error ? error.message : String(error)}`);
  }
  return findings;
};

const packRoot = (root) =>
  JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    }),
  )[0].files.map(({ path }) => path.replaceAll('\\', '/'));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { default: '.', type: 'string' } } });
  try {
    const root = resolve(values.root);
    const findings = preparedReleaseFindings({ packedFiles: packRoot(root), root });
    for (const finding of findings) process.stderr.write(`::error::${finding}\n`);
    if (findings.length) throw new Error(`${findings.length} prepared release findings`);
    process.stdout.write('prepared release tree is complete\n');
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
