#!/usr/bin/env node
// Download the `wasm` artifact of the latest successful CI run on `main` into
// src/wasm/, so local tests run without Docker or an Emscripten build.
//
//   pnpm run fetch:wasm                 latest green `main` push
//   pnpm run fetch:wasm -- --run <id>   a specific CI run, e.g. a pull request's
//
// Artifact downloads need a token even for this public repository. The script
// reads GH_TOKEN or GITHUB_TOKEN, then falls back to `gh auth token`; any
// token that can read public repositories works.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const repository = 'taucad/libassimp';
const root = new URL('../', import.meta.url);
const destination = new URL('src/wasm/', root);
const expected = ['libassimp.js', 'libassimp.wasm', 'libassimp.manifest.json'];

const { values } = parseArgs({
  options: { run: { type: 'string' }, branch: { type: 'string', default: 'main' } },
});

const token = (() => {
  const fromEnvironment = process.env['GH_TOKEN'] || process.env['GITHUB_TOKEN'];
  if (fromEnvironment) return fromEnvironment;
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      'fetch:wasm needs GH_TOKEN, GITHUB_TOKEN or a signed-in `gh` CLI to download CI artifacts.',
    );
  }
})();

const api = async (path) => {
  const response = await fetch(
    path.startsWith('https:') ? path : `https://api.github.com/repos/${repository}${path}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub API ${path} answered ${response.status} ${response.statusText}`);
  return response;
};

/** Every stored or deflated member of a ZIP archive, read from its central directory. */
const unzip = (archive) => {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('the artifact is not a ZIP archive');
  const members = new Map();
  let offset = archive.readUInt32LE(end + 16);
  for (let index = archive.readUInt16LE(end + 10); index > 0; index -= 1) {
    if (archive.readUInt32LE(offset) !== 0x0201_4b50) throw new Error('corrupt ZIP central directory');
    const method = archive.readUInt16LE(offset + 10);
    const size = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`${name} uses unsupported ZIP method ${method}`);
    members.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  return members;
};

const runId =
  values.run ??
  (
    await (
      await api(
        `/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(values.branch)}&event=push&status=success&per_page=1`,
      )
    ).json()
  ).workflow_runs[0]?.id;
if (runId === undefined) throw new Error(`no successful CI push run on ${values.branch}`);

const { artifacts } = await (await api(`/actions/runs/${runId}/artifacts?name=wasm`)).json();
const artifact = artifacts.find(({ name, expired }) => name === 'wasm' && !expired);
if (artifact === undefined) throw new Error(`CI run ${runId} has no unexpired wasm artifact`);

const archive = Buffer.from(await (await api(artifact.archive_download_url)).arrayBuffer());
const members = unzip(archive);
for (const name of expected) {
  if (!members.has(name)) throw new Error(`the wasm artifact of run ${runId} lacks ${name}`);
}
mkdirSync(destination, { recursive: true });
for (const [name, bytes] of members) {
  if (!/^libassimp\.[\w.]+$/u.test(name)) throw new Error(`unexpected artifact member ${name}`);
  writeFileSync(new URL(name, destination), bytes);
}

// The binary only matches this checkout when the engine and toolchain do.
const manifest = JSON.parse(members.get('libassimp.manifest.json').toString('utf8'));
const warnings = [];
const image = readFileSync(new URL('emsdk-image.txt', root), 'utf8').trim();
if (manifest.image !== image) warnings.push(`it was built with ${manifest.image}, not ${image}`);
try {
  const engine = execFileSync('git', ['-C', fileURLToPath(new URL('assimp', root)), 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (manifest.engineSha !== engine)
    warnings.push(`its engine is ${manifest.engineSha}, the submodule is ${engine}`);
} catch {
  warnings.push('the assimp submodule is not checked out (git submodule update --init assimp)');
}
console.log(
  `wrote ${members.size} files from CI run ${runId} (${artifact.size_in_bytes} bytes) to src/wasm/`,
);
for (const warning of warnings) console.warn(`warning: ${warning}; tests that pin output bytes may fail`);
