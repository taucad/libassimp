#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const npmView = (name, version) => {
  try {
    return JSON.parse(
      execFileSync('npm', ['view', `${name}@${version}`, '--json'], {
        encoding: 'utf8',
        timeout: 30_000,
      }),
    );
  } catch {
    return null;
  }
};

export const waitForRegistry = async ({
  intervalMs = 30_000,
  log = console.log,
  maxIntervalMs = 300_000,
  now = Date.now,
  sleep = delay,
  tarballs,
  timeoutMs = 1_800_000,
  view = npmView,
}) => {
  const pending = new Map(Object.entries(tarballs.packages));
  const started = now();
  for (let attempt = 1; pending.size; attempt += 1) {
    for (const [name, packed] of pending) {
      const metadata = view(name, packed.version);
      if (metadata?.dist?.integrity && metadata.dist.integrity !== packed.integrity) {
        throw new Error(`${name}@${packed.version}: registry integrity differs from the packed tarball`);
      }
      if (
        metadata?.dist?.integrity === packed.integrity &&
        Object.keys(metadata.dist.attestations ?? {}).length > 0
      ) {
        pending.delete(name);
      }
    }
    const total = Object.keys(tarballs.packages).length;
    log(`attempt ${attempt}: ${total - pending.size}/${total} packages available`);
    if (!pending.size) return;
    if (now() >= started + timeoutMs) {
      throw new Error(`timed out waiting for: ${[...pending.keys()].join(', ')}`);
    }
    await sleep(Math.min(intervalMs * 2 ** (attempt - 1), maxIntervalMs, started + timeoutMs - now()));
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { tarballs: { type: 'string' } } });
  try {
    if (!values.tarballs) throw new Error('expected --tarballs <test-tarballs.json>');
    await waitForRegistry({ tarballs: JSON.parse(readFileSync(values.tarballs, 'utf8')) });
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
