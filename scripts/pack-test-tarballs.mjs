#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';

export const npmPack = (directory, destination) => {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
      cwd: directory,
      encoding: 'utf8',
    }),
  );
  if (!packed) throw new Error(`npm pack produced no tarball for ${directory}`);
  const { filename, integrity, name, size, version } = packed;
  return { filename, integrity, name, size, version };
};

export const packTestTarballs = ({ out, pack = npmPack, root }) => {
  const rootDirectory = resolve(root);
  const outDirectory = resolve(out);
  const { manifest, packages } = readNapiTargets(join(rootDirectory, 'package.json'));
  mkdirSync(outDirectory, { recursive: true });
  const sources = [
    { directory: rootDirectory, name: manifest.name },
    ...packages.map((target) => ({
      directory: join(rootDirectory, 'npm', target.suffix),
      name: target.name,
      target,
    })),
  ];
  const packed = sources.map(({ directory, name, target }) => {
    const entry = pack(directory, outDirectory);
    if (entry.name !== name) throw new Error(`${directory} packed ${entry.name}, expected ${name}`);
    if (entry.version !== manifest.version) {
      throw new Error(`${entry.name} packed version ${entry.version}, expected ${manifest.version}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`${entry.name} packed an invalid size`);
    }
    if (target === undefined) return entry;
    return {
      ...entry,
      addonSha256: createHash('sha256')
        .update(readFileSync(join(directory, target.binary)))
        .digest('hex'),
      target: {
        cpu: target.cpu,
        ...(target.libc === undefined ? {} : { libc: target.libc }),
        os: target.os,
        triple: target.triple,
      },
    };
  });
  const output = {
    packages: Object.fromEntries(
      packed
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, ...candidate }) => [name, candidate]),
    ),
    version: manifest.version,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  writeFileSync(join(outDirectory, 'test-tarballs.json'), json);
  writeFileSync(join(rootDirectory, 'test-tarballs.json'), json);
  return output;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, root: { default: '.', type: 'string' } },
  });
  try {
    if (!values.out) throw new Error('expected --out <directory>');
    const result = packTestTarballs({ out: values.out, root: values.root });
    process.stdout.write(`packed ${Object.keys(result.packages).length} tarballs at ${result.version}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
