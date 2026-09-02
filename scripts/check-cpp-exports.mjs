// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const binary = process.argv[2];
assert(binary, 'usage: node scripts/check-cpp-exports.mjs <addon.node>');

const command = process.platform === 'win32' ? 'dumpbin' : 'nm';
const arguments_ =
  process.platform === 'win32'
    ? ['/nologo', '/exports', binary]
    : process.platform === 'darwin'
      ? ['-gjU', binary]
      : ['-D', '--defined-only', binary];
const result = spawnSync(command, arguments_, { encoding: 'utf8' });
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);

const expected = process.platform === 'darwin' ? '_napi_register_module_v1' : 'napi_register_module_v1';
const symbols =
  process.platform === 'win32'
    ? [...result.stdout.matchAll(/^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)\s*$/gimu)].map((match) => match[1])
    : result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
assert.deepEqual(symbols, [expected], `unexpected Node addon exports:\n${result.stdout}`);
