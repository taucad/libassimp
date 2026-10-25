// Copyright 2026 Richard Fontein
// SPDX-License-Identifier: Apache-2.0

// Emit the release SBOM (CycloneDX 1.6 JSON) and the OSV commit manifest for
// the C/C++ code that ships inside the Wasm binary and the native addons.
//
//   node scripts/generate-sbom.mjs --out <dir>   write <dir>/libassimp.cdx.json
//   node scripts/generate-sbom.mjs --check       fail if osv-cpp-pins.json is stale
//   node scripts/generate-sbom.mjs --write       regenerate osv-cpp-pins.json
//
// Sources, in order: the engine submodule commit, the FetchContent pins in the
// engine's code/CMakeLists.txt, the vendored assimp/contrib libraries that the
// compiled format set links, the Emscripten image that supplies libc, libc++
// and dlmalloc to the Wasm binary, node-addon-api (headers compiled into the
// addon), and every npm package in pnpm-lock.yaml (build-time only, so their
// scope is `excluded`). The osv-cpp-pins.json manifest lists every component
// pinned to a git commit, which is how OSV's GIT ecosystem matches C/C++ code
// that has no package registry.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNapiTargets } from './lib/napi-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifestPath = join(root, 'osv-cpp-pins.json');

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

const engineCommit = () => {
  const [, , sha] = git('ls-tree', 'HEAD', 'assimp').split(/\s+/u);
  if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('cannot read the assimp submodule commit');
  return sha;
};

const githubSlug = (url) => /github\.com\/([^/]+\/[^/.]+?)(?:\.git)?(?:\/|$)/u.exec(url)?.[1];

/** Every FetchContent_Declare in the engine's CMake, with ${VAR} resolved from set(VAR "value"). */
export const parseFetchContent = (cmake) => {
  const variables = new Map();
  for (const [, name, value] of cmake.matchAll(/^\s*set\(\s*(\w+)\s+"?([^")\s]+)"?\s*\)/gmu)) {
    variables.set(name, value);
  }
  const expand = (value) =>
    value.replaceAll(/\$\{(\w+)\}/gu, (_, name) => variables.get(name) ?? `\${${name}}`);
  const pins = [];
  for (const [, body] of cmake.matchAll(/FetchContent_Declare\(([^)]*)\)/gu)) {
    const tokens = body
      .split(/\s+/u)
      .filter(Boolean)
      .map((token) => token.replaceAll('"', ''));
    const field = (key) => {
      const index = tokens.indexOf(key);
      return index === -1 ? undefined : expand(tokens[index + 1]);
    };
    const name = tokens[0];
    const url = field('URL');
    const repository = field('GIT_REPOSITORY') ?? url;
    const commit = field('GIT_TAG') ?? /\/archive\/([0-9a-f]{40})\./u.exec(url ?? '')?.[1];
    if (!repository || !commit) throw new Error(`FetchContent ${name} has no repository or pin`);
    if (!/^[0-9a-f]{40}$/u.test(commit))
      throw new Error(`FetchContent ${name} is pinned to ${commit}, not a commit`);
    pins.push({
      name: name.replace(/_repo$/u, ''),
      repository: repository.replace(/\/archive\/.*$/u, ''),
      commit,
    });
  }
  return pins;
};

// Vendored sources compiled into the shipped binaries. googletest (tests),
// draco (ASSIMP_BUILD_DRACO=OFF) and Open3DGC (glTF 1 only, which is compiled
// out) are deliberately absent. Versions come from the vendored headers.
const VENDORED = [
  {
    name: 'zlib',
    path: 'zlib/zlib.h',
    version: /#define ZLIB_VERSION "([^"]+)"/u,
    cpe: 'zlib:zlib',
    license: 'Zlib',
  },
  {
    name: 'minizip',
    path: 'unzip/unzip.h',
    version: /Version ([\d.]+),/u,
    cpe: 'zlib:minizip',
    license: 'Zlib',
  },
  { name: 'kuba-zip', path: 'zip/src/zip.h', license: 'Unlicense' },
  {
    name: 'pugixml',
    path: 'pugixml/src/pugixml.hpp',
    version: /PUGIXML_VERSION \d+ \/\/ ([\d.]+)/u,
    cpe: 'pugixml_project:pugixml',
    license: 'MIT',
  },
  {
    name: 'rapidjson',
    path: 'rapidjson/include/rapidjson/rapidjson.h',
    version: (text) =>
      ['MAJOR', 'MINOR', 'PATCH']
        .map((part) => new RegExp(`RAPIDJSON_${part}_VERSION (\\d+)`, 'u').exec(text)?.[1])
        .join('.'),
    cpe: 'tencent:rapidjson',
    license: 'MIT',
  },
  {
    name: 'stb_image',
    path: 'stb/stb_image.h',
    version: /stb_image - v([\d.]+)/u,
    cpe: 'nothings:stb_image',
    license: 'MIT OR Unlicense',
  },
  { name: 'utf8cpp', path: 'utf8cpp/source/utf8.h', license: 'BSL-1.0' },
  { name: 'poly2tri', path: 'poly2tri/LICENSE', license: 'BSD-3-Clause' },
  { name: 'clipper', path: 'clipper/clipper.hpp', version: /CLIPPER_VERSION "([^"]+)"/u, license: 'BSL-1.0' },
  { name: 'openddlparser', path: 'openddlparser/LICENSE', license: 'MIT' },
  { name: 'earcut-hpp', path: 'earcut-hpp/earcut.hpp', license: 'ISC' },
];

const vendored = (engine) => {
  const contrib = join(root, 'assimp', 'contrib');
  if (!existsSync(contrib))
    throw new Error('assimp/contrib is missing: run git submodule update --init assimp');
  return VENDORED.map((entry) => {
    const text = readFileSync(join(contrib, entry.path), 'utf8');
    const version =
      typeof entry.version === 'function'
        ? entry.version(text)
        : entry.version
          ? entry.version.exec(text)?.[1]
          : undefined;
    if (entry.version && !version) throw new Error(`cannot read the vendored ${entry.name} version`);
    return { ...entry, version: version ?? `assimp-${engine.slice(0, 12)}` };
  });
};

/** pnpm v9 lockfile `packages:` keys, with their SHA-512 integrity. */
export const parseLockfilePackages = (lockfile) => {
  const section = lockfile.split(/^packages:\s*$/mu)[1]?.split(/^snapshots:\s*$/mu)[0] ?? '';
  const packages = [];
  for (const [, key, integrity] of section.matchAll(
    /^ {2}'?(.+?)'?:\n\s+resolution: \{integrity: (sha512-[^,}]+)/gmu,
  )) {
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    packages.push({ name: key.slice(0, at), version: key.slice(at + 1), integrity });
  }
  return packages;
};

const npmPurl = (name, version) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${encodeURIComponent(version)}`;

const gitComponent = ({ name, repository, commit, license, description }) => {
  const slug = githubSlug(repository);
  return {
    type: 'library',
    'bom-ref': `git:${name}@${commit}`,
    name,
    version: commit,
    ...(description ? { description } : {}),
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
    ...(slug ? { purl: `pkg:github/${slug}@${commit}` } : {}),
    externalReferences: [{ type: 'vcs', url: repository }],
    properties: [{ name: 'libassimp:pin', value: 'git-commit' }],
  };
};

export const collect = () => {
  const engine = engineCommit();
  const cmakePath = join(root, 'assimp', 'code', 'CMakeLists.txt');
  if (!existsSync(cmakePath))
    throw new Error('assimp is not checked out: run git submodule update --init assimp');
  const fetched = parseFetchContent(readFileSync(cmakePath, 'utf8'));
  const gitPins = [
    {
      name: 'assimp',
      repository: 'https://github.com/taucad/assimp',
      commit: engine,
      license: 'BSD-3-Clause',
      description: 'Open Asset Import Library engine (taucad fork), the assimp/ submodule',
    },
    ...fetched,
    // libassimp's own pins: mimalloc in the Linux addon.
    ...parseFetchContent(read('CMakeLists.txt')),
  ].toSorted((a, b) => a.name.localeCompare(b.name));
  return { engine, gitPins, vendored: vendored(engine) };
};

/** osv-scanner's custom lockfile format: `-L osv-scanner:osv-cpp-pins.json`. */
export const osvManifest = ({ gitPins }) =>
  `${JSON.stringify(
    {
      $comment:
        'Generated by scripts/generate-sbom.mjs from the assimp submodule and its FetchContent pins. Do not edit; run node scripts/generate-sbom.mjs --write.',
      results: [
        {
          source: { path: 'osv-cpp-pins.json', type: 'lockfile' },
          packages: gitPins.map(({ name, commit }) => ({ package: { name, commit } })),
        },
      ],
    },
    undefined,
    2,
  )}\n`;

export const sbom = ({ engine, gitPins, vendored: libraries }) => {
  const manifest = JSON.parse(read('package.json'));
  const { packages: platforms } = readNapiTargets(join(root, 'package.json'));
  const emsdk = read('emsdk-image.txt').trim();
  const [emsdkName, emsdkDigest] = emsdk.split('@');
  const created = new Date(Number(git('log', '-1', '--format=%ct', 'HEAD')) * 1000).toISOString();

  const components = [
    ...gitPins.map(gitComponent),
    ...libraries.map((library) => ({
      type: 'library',
      'bom-ref': `vendored:${library.name}@${library.version}`,
      name: library.name,
      version: library.version,
      licenses: [{ expression: library.license }],
      ...(library.cpe ? { cpe: `cpe:2.3:a:${library.cpe}:${library.version}:*:*:*:*:*:*:*` } : {}),
      purl: `pkg:generic/${library.name}@${encodeURIComponent(library.version)}`,
      properties: [
        { name: 'libassimp:pin', value: 'vendored' },
        { name: 'libassimp:vendored-path', value: `assimp/contrib/${library.path}` },
        { name: 'libassimp:vendored-by', value: `git:assimp@${engine}` },
      ],
    })),
    {
      type: 'platform',
      'bom-ref': `toolchain:emsdk@${emsdkDigest}`,
      name: emsdkName,
      version: emsdkDigest,
      description:
        'Emscripten toolchain image; supplies libc, libc++ and dlmalloc linked into libassimp.wasm',
      purl: `pkg:docker/${emsdkName.split(':')[0]}@${encodeURIComponent(emsdkDigest)}`,
    },
    ...platforms.map((platform) => ({
      type: 'library',
      'bom-ref': npmPurl(platform.name, manifest.version),
      name: platform.name,
      version: manifest.version,
      scope: 'optional',
      purl: npmPurl(platform.name, manifest.version),
      description: `Native addon for ${platform.suffix}, built from this repository`,
    })),
    ...parseLockfilePackages(read('pnpm-lock.yaml')).map(({ name, version, integrity }) => ({
      type: 'library',
      'bom-ref': npmPurl(name, version),
      name,
      version,
      // node-addon-api headers are compiled into every native addon.
      scope: name === 'node-addon-api' ? 'required' : 'excluded',
      purl: npmPurl(name, version),
      hashes: [{ alg: 'SHA-512', content: Buffer.from(integrity.slice(7), 'base64').toString('hex') }],
    })),
  ];
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: created,
      tools: { components: [{ type: 'application', name: 'libassimp generate-sbom.mjs' }] },
      component: {
        type: 'library',
        'bom-ref': npmPurl(manifest.name, manifest.version),
        name: manifest.name,
        version: manifest.version,
        licenses: [{ license: { id: manifest.license } }],
        purl: npmPurl(manifest.name, manifest.version),
        externalReferences: [{ type: 'vcs', url: `https://github.com/taucad/libassimp` }],
      },
    },
    components,
    dependencies: [
      {
        ref: npmPurl(manifest.name, manifest.version),
        dependsOn: [
          `git:assimp@${engine}`,
          `toolchain:emsdk@${emsdkDigest}`,
          ...platforms.map((platform) => npmPurl(platform.name, manifest.version)),
        ],
      },
      {
        ref: `git:assimp@${engine}`,
        dependsOn: [
          ...gitPins
            .filter(({ name }) => name !== 'assimp')
            .map(({ name, commit }) => `git:${name}@${commit}`),
          ...libraries.map(({ name, version }) => `vendored:${name}@${version}`),
        ],
      },
    ],
  };
  const body = JSON.stringify(document);
  const hash = createHash('sha256').update(body).digest('hex');
  // A content-derived serial keeps the document reproducible for one commit.
  document.serialNumber = `urn:uuid:${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return `${JSON.stringify(document, undefined, 2)}\n`;
};

const main = () => {
  const args = process.argv.slice(2);
  const collected = collect();
  if (args[0] === '--check') {
    const expected = osvManifest(collected);
    const actual = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    if (actual !== expected) {
      throw new Error('osv-cpp-pins.json is stale: run node scripts/generate-sbom.mjs --write');
    }
    return;
  }
  if (args[0] === '--write') {
    writeFileSync(manifestPath, osvManifest(collected));
    return;
  }
  if (args[0] === '--out' && args[1]) {
    mkdirSync(args[1], { recursive: true });
    writeFileSync(join(args[1], 'libassimp.cdx.json'), sbom(collected));
    return;
  }
  throw new Error('usage: generate-sbom.mjs --out <dir> | --check | --write');
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
