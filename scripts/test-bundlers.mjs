#!/usr/bin/env node
// Install the packed libassimp tarball into consumer apps the way users do,
// build each with its bundler, and convert cube.obj in Chromium. Each page's
// GLB must equal the bytes the same tarball produces in Node.
//
//   node scripts/test-bundlers.mjs --tarballs tarballs   (CI, after `assemble`)
//   node scripts/test-bundlers.mjs --tarball libassimp-0.4.0.tgz
//
// Fixtures: Vite build, Vite dev, webpack 5, Next.js (Turbopack, static export),
// esbuild, and a CDN-style cross-origin static host of the tarball's files.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: { tarballs: { type: 'string' }, tarball: { type: 'string' }, keep: { type: 'boolean' } },
});
// The root tarball, plus the Linux addon package when CI's frozen set is given,
// mirroring the benchmark job's install. Browsers never load the addon.
const tarballs = (() => {
  if (values.tarball) return [resolve(values.tarball)];
  const directory = values.tarballs ?? 'tarballs';
  const { packages } = JSON.parse(readFileSync(join(directory, 'test-tarballs.json'), 'utf8'));
  return ['libassimp', 'libassimp-linux-x64-gnu']
    .filter((name) => packages[name] !== undefined)
    .map((name) => resolve(directory, packages[name].filename));
})();

const work = mkdtempSync(join(tmpdir(), 'libassimp-bundlers-'));
const run = (command, args, cwd = work) =>
  execFileSync(command, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};

/** A static file server; `cors` makes it behave like a public CDN. */
const serve = (directory, { cors = false } = {}) =>
  new Promise((ready) => {
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      let file = normalize(join(directory, path));
      if (!file.startsWith(directory)) return void response.writeHead(403).end();
      if (path.endsWith('/')) file = join(file, 'index.html');
      try {
        const body = readFileSync(file);
        response.writeHead(200, {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
          ...(cors ? { 'access-control-allow-origin': '*' } : {}),
        });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () =>
      ready({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });

/** Start a dev server and resolve once it prints its local URL. */
const devServer = (command, args, cwd) =>
  new Promise((ready, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /(http:\/\/(?:localhost|127\.0\.0\.1):\d+)/u.exec(stripVTControlCharacters(output));
      if (match) ready({ child, origin: match[1] });
    });
    child.on('exit', (code) => fail(new Error(`${command} exited with ${code}: ${output}`)));
  });

try {
  // 1. A consumer project: pinned bundlers from the lockfile, then the tarball.
  cpSync(new URL('../tests/bundlers/', import.meta.url), work, { recursive: true });
  writeFileSync(
    join(work, 'src/cube.js'),
    `export const cube = ${JSON.stringify(readFileSync(join(root, 'tests/fixtures/cube.obj'), 'utf8'))};\n`,
  );
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  run('npm', ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  const bin = (name) => join(work, 'node_modules/.bin', name);

  // 2. The reference bytes: the same tarball's Wasm entry in Node.
  const installed = join(work, 'node_modules/libassimp');
  const { convert } = await import(pathToFileURL(join(installed, 'dist/index.mjs')).href);
  const cube = readFileSync(join(root, 'tests/fixtures/cube.obj'));
  const expected = (await convert({ name: 'cube.obj', bytes: new Uint8Array(cube) }, { to: 'glb' })).files[0];

  // 3. Build the static fixtures.
  run(bin('vite'), ['build', '--logLevel', 'warn'], join(work, 'vite'));
  // webpack's own Node API: the CLI is a separate package that adds nothing here.
  const webpack = createRequire(join(work, 'package.json'))('webpack');
  const config = (await import(pathToFileURL(join(work, 'webpack/webpack.config.mjs')).href)).default;
  const stats = await new Promise((done, fail) =>
    webpack(config, (error, result) => (error ? fail(error) : done(result))),
  );
  if (stats.hasErrors()) throw new Error(stats.toString('errors-only'));
  cpSync(join(work, 'webpack/index.html'), join(work, 'webpack/dist/index.html'));
  run(
    bin('esbuild'),
    ['../src/main.js', '--bundle', '--format=esm', '--outdir=dist', '--log-level=warning'],
    join(work, 'esbuild'),
  );
  // esbuild leaves `new URL('./wasm/…', import.meta.url)` alone: copy the pair beside the bundle.
  cpSync(join(installed, 'dist/wasm'), join(work, 'esbuild/dist/wasm'), { recursive: true });
  cpSync(join(work, 'esbuild/index.html'), join(work, 'esbuild/dist/index.html'));
  run(bin('next'), ['build'], join(work, 'next'));

  // 4. Drive each page in Chromium.
  const cdn = await serve(installed, { cors: true });
  mkdirSync(join(work, 'cdn'), { recursive: true });
  writeFileSync(
    join(work, 'cdn/index.html'),
    `<!doctype html><meta charset="utf-8"><script type="module">
${readFileSync(join(work, 'src/cube.js'), 'utf8')}
import { convert } from '${cdn.origin}/dist/index.mjs';
try {
  const { files } = await convert({ name: 'cube.obj', bytes: new TextEncoder().encode(cube) }, { to: 'glb' });
  window.__libassimp = { ok: true, name: files[0].name, bytes: Array.from(files[0].bytes) };
} catch (error) {
  window.__libassimp = { ok: false, error: String(error?.stack ?? error) };
}
</script>`,
  );
  const servers = [cdn.server];
  const pages = [];
  for (const [name, directory] of [
    ['vite build', 'vite/dist'],
    ['webpack 5', 'webpack/dist'],
    ['esbuild', 'esbuild/dist'],
    ['Next.js (Turbopack)', 'next/out'],
    ['CDN (cross-origin static files)', 'cdn'],
  ]) {
    const { server, origin } = await serve(join(work, directory));
    servers.push(server);
    pages.push([name, `${origin}/`]);
  }
  const vite = await devServer(
    bin('vite'),
    ['--host', '127.0.0.1', '--port', '0', '--strictPort', 'false'],
    join(work, 'vite'),
  );
  pages.push(['vite dev', `${vite.origin}/`]);

  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const [name, url] of pages) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('requestfailed', (request) => errors.push(`request failed: ${request.url()}`));
      try {
        await page.goto(url);
        await page.waitForFunction(() => globalThis.__libassimp !== undefined, undefined, {
          timeout: 60_000,
        });
        const result = await page.evaluate(() => globalThis.__libassimp);
        if (!result.ok) throw new Error(result.error);
        if (result.name !== expected.name)
          throw new Error(`output name ${result.name}, expected ${expected.name}`);
        if (Buffer.compare(Buffer.from(result.bytes), Buffer.from(expected.bytes)) !== 0) {
          throw new Error(
            `GLB bytes differ from Node (${result.bytes.length} vs ${expected.bytes.length} bytes)`,
          );
        }
        console.log(`ok   ${name}: ${result.bytes.length}-byte ${result.name} equals Node's`);
      } catch (error) {
        failures.push(name);
        console.error(
          `FAIL ${name}: ${error.message}${errors.length ? `\n     ${errors.join('\n     ')}` : ''}`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    vite.child.kill();
    for (const server of servers) server.close();
  }
  if (failures.length) {
    process.exitCode = 1;
    console.error(`bundler fixtures failed: ${failures.join(', ')}`);
  }
} finally {
  if (values.keep) console.log(`kept ${work}`);
  else rmSync(work, { force: true, recursive: true });
}
