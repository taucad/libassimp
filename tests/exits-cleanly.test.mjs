// Process-exit hygiene for the shared one-shot instance: the compiled module
// is passive memory, not an event-loop handle, so a script that converts
// through the module-level function exits on its own without a dispose.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const script = `
import { readFileSync } from 'node:fs';
const { convert } = await import('./dist/index.mjs');
const bytes = new Uint8Array(readFileSync('tests/fixtures/cube.obj'));
const [glb, stl] = await Promise.all([
  convert({ name: 'cube.obj', bytes }, { to: 'glb' }),
  convert({ name: 'cube.obj', bytes }, { to: 'stl' }),
]);
// One joined string: \`console.log\` colours a bare number under a pty.
console.log([glb.files[0].name, stl.files[0].name, process.listenerCount('unhandledRejection')].join(' '));
`;

test('a process converting through the one-shot API exits on its own', async () => {
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        // The kill is the assertion: an instance holding the event loop open
        // would never reach exit.
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
      (error, out, errorOutput) => {
        if (error) reject(new Error(`${error.message}\n${errorOutput}`));
        else resolve(out);
      },
    );
  });

  expect(stdout.trim()).toBe('result.glb result.stl 0');
});
