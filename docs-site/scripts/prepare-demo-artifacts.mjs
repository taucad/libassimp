#!/usr/bin/env node

import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/demo/', import.meta.url);
const destination = new URL('../../dist/wasm/', import.meta.url);

mkdirSync(fileURLToPath(destination), { recursive: true });
for (const extension of ['js', 'wasm']) {
  const name = `libassimp-full.${extension}`;
  copyFileSync(new URL(name, source), new URL(name, destination));
}
