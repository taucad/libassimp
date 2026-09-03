#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';

const RUNNER = { darwin: 'macos-15', linux: 'ubuntu-24.04', win32: 'windows-2022' };
export const ELECTRON_VERSION = '38.7.2';
export const NODE_VERSION = '22.14.0';
export const NODE_VERSIONS = [NODE_VERSION, '24', '26'];

export const nativeMatrices = (packageJson = new URL('../package.json', import.meta.url)) => {
  const { packages } = readNapiTargets(packageJson);
  const build = packages.map(({ os, suffix, triple }) => ({
    os: RUNNER[os],
    recipe: os === 'linux' ? 'manylinux' : 'host',
    suffix,
    target: triple,
  }));
  const smoke = packages.flatMap(({ os, suffix }) => [
    ...NODE_VERSIONS.map((node) => {
      const scale = os === 'linux' && node === '26';
      return {
        lane: `node-${node}`,
        minScaleRssBytes: scale ? '4294967296' : '0',
        node,
        os: RUNNER[os],
        runtime: 'node',
        scale: scale ? '1' : '0',
        scaleBytes: scale ? '671088640' : '',
        suffix,
      };
    }),
    {
      electron: ELECTRON_VERSION,
      lane: `electron-${ELECTRON_VERSION}`,
      minScaleRssBytes: '0',
      node: NODE_VERSION,
      os: RUNNER[os],
      runtime: 'electron',
      scale: '0',
      scaleBytes: '',
      suffix,
    },
  ]);
  if (build.some(({ os }) => !os)) throw new Error('a native target has no GitHub-hosted runner');
  return { build, smoke };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { kind: { default: 'build', type: 'string' } } });
    const matrix = nativeMatrices()[values.kind];
    if (!matrix) throw new Error(`unknown matrix kind: ${values.kind}`);
    const output = `matrix=${JSON.stringify(matrix)}\n`;
    process.stdout.write(output);
    if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], output);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
