#!/usr/bin/env node

import { closeSync, openSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SCALE_BYTES = 64 * 1024 * 1024;
const BYTES_PER_POINT = 12;
const CHUNK_POINTS = 65_536;

const headerFor = (points) =>
  Buffer.from(
    `ply\nformat binary_little_endian 1.0\ncomment deterministic libassimp scale fixture\nelement vertex ${points}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`,
  );

export const scalePointCountForSize = (size) => {
  if (!Number.isSafeInteger(size) || size < 256) throw new Error('scale fixture size is too small');
  let points = Math.max(1, Math.ceil((size - 128) / BYTES_PER_POINT));
  while (headerFor(points).length + points * BYTES_PER_POINT < size) points += 1;
  while (points > 1 && headerFor(points - 1).length + (points - 1) * BYTES_PER_POINT >= size) {
    points -= 1;
  }
  return points;
};

export const readScalePointCount = (bytes) => {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 512)).toString(
    'utf8',
  );
  const row = header.split('\n').find((line) => line.startsWith('element vertex '));
  const points = Number(row?.slice('element vertex '.length));
  if (!Number.isSafeInteger(points) || points <= 0) throw new Error('scale PLY has no valid vertex count');
  return points;
};

export const writeScaleFixture = (path, size = SCALE_BYTES) => {
  const points = scalePointCountForSize(size);
  const header = headerFor(points);
  const file = openSync(path, 'w');
  try {
    writeSync(file, header);
    for (let base = 0; base < points; base += CHUNK_POINTS) {
      const count = Math.min(CHUNK_POINTS, points - base);
      const chunk = Buffer.allocUnsafe(count * BYTES_PER_POINT);
      for (let offset = 0; offset < count; offset += 1) {
        const index = base + offset;
        chunk.writeFloatLE(index % 1_024, offset * BYTES_PER_POINT);
        chunk.writeFloatLE(Math.floor(index / 1_024) % 1_024, offset * BYTES_PER_POINT + 4);
        chunk.writeFloatLE(Math.floor(index / 1_048_576), offset * BYTES_PER_POINT + 8);
      }
      writeSync(file, chunk);
    }
  } finally {
    closeSync(file);
  }
  return header.length + points * BYTES_PER_POINT;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 1) throw new Error('expected one output path');
  const size = Number(process.env['LIBASSIMP_SCALE_BYTES'] ?? SCALE_BYTES);
  process.stdout.write(`${writeScaleFixture(positionals[0], size)}\n`);
}
