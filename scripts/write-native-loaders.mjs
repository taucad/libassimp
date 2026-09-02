#!/usr/bin/env node

import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { writeJsBinding } from '@napi-rs/cli';

import { readNapiTargets } from './lib/napi-targets.mjs';

const { manifest } = readNapiTargets(new URL('../package.json', import.meta.url));
const outputDir = fileURLToPath(new URL('../dist/native/', import.meta.url));
const idents = [
  'buildIdentity',
  'destroyPlan',
  'napiVersion',
  'packageVersion',
  'pendingName',
  'preparePlan',
  'runPlan',
  'supplyPlan',
  'takePlanResult',
];

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });
for (const [jsBinding, esm] of [
  ['index.js', true],
  ['index.cjs', false],
]) {
  await writeJsBinding({
    binaryName: manifest.napi.binaryName,
    esm,
    idents,
    jsBinding,
    outputDir,
    packageName: manifest.napi.packageName,
    platform: true,
    version: manifest.version,
  });
}
