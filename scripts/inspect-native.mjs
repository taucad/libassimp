#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';

const EXPECTED = {
  'darwin-arm64': { format: 'macho', machine: 0x0100000c },
  'linux-x64-gnu': { format: 'elf', machine: 62 },
  'win32-x64-msvc': { format: 'pe', machine: 0x8664 },
};

export const inspectHeader = (bytes) => {
  if (bytes.length < 64) return { format: null, machine: null };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const little = bytes[5] === 1;
    return {
      class: bytes[4] === 2 ? 64 : 32,
      format: 'elf',
      machine: little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18),
    };
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { class: 64, format: 'macho', machine: bytes.readUInt32LE(4) };
  }
  if (bytes.subarray(0, 2).toString('latin1') === 'MZ') {
    const offset = bytes.readUInt32LE(0x3c);
    if (offset + 6 <= bytes.length && bytes.subarray(offset, offset + 4).toString('latin1') === 'PE\0\0') {
      return { class: 64, format: 'pe', machine: bytes.readUInt16LE(offset + 4) };
    }
  }
  return { format: null, machine: null };
};

export const inspectNative = ({ npmDir = 'npm', root = '.' } = {}) => {
  const directory = resolve(root);
  const { packages } = readNapiTargets(join(directory, 'package.json'));
  const findings = [];
  const inventory = {};
  const expectedPaths = new Set(
    packages.map(({ binary, suffix }) => join(resolve(directory, npmDir), suffix, binary)),
  );
  const walk = (path) => {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(path, entry.name))
        : entry.name.endsWith('.node')
          ? [join(path, entry.name)]
          : [],
    );
  };
  for (const file of walk(resolve(directory, npmDir))) {
    if (!expectedPaths.has(file)) {
      findings.push(`${relative(directory, file)} is an unexpected native binary`);
    }
  }
  for (const target of packages) {
    const file = join(resolve(directory, npmDir), target.suffix, target.binary);
    if (!existsSync(file)) {
      findings.push(`${target.suffix}: ${relative(directory, file)} is missing`);
      continue;
    }
    const bytes = readFileSync(file);
    const header = inspectHeader(bytes);
    const expected = EXPECTED[target.suffix];
    if (
      !expected ||
      header.format !== expected.format ||
      header.machine !== expected.machine ||
      header.class !== 64
    ) {
      findings.push(
        `${target.suffix}: expected ${expected?.format ?? 'configured'} 64-bit machine ` +
          `${expected?.machine}, found ${JSON.stringify(header)}`,
      );
    }
    inventory[target.suffix] = {
      bytes: bytes.length,
      ...header,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return { findings, inventory };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'npm-dir': { default: 'npm', type: 'string' } } });
  const { findings, inventory } = inspectNative({ npmDir: values['npm-dir'] });
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  for (const finding of findings) process.stderr.write(`::error::${finding}\n`);
  if (findings.length) process.exit(1);
}
