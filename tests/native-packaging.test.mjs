import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { preparedReleaseFindings } from '../scripts/check-prepared-release.mjs';
import {
  elfDependencies,
  maxCxxabiVersion,
  maxGlibcVersion,
  maxGlibcxxVersion,
} from '../scripts/check-native-host.mjs';
import { inspectHeader } from '../scripts/inspect-native.mjs';
import { readNapiTargets } from '../scripts/lib/napi-targets.mjs';
import { nativeMatrices, ELECTRON_VERSION, NODE_VERSION, NODE_VERSIONS } from '../scripts/native-matrix.mjs';
import { packTestTarballs } from '../scripts/pack-test-tarballs.mjs';
import { PACKAGE_FILES } from '../scripts/package-files.mjs';
import { waitForRegistry } from '../scripts/registry-wait.mjs';
import {
  readScalePointCount,
  SCALE_BYTES,
  scalePointCountForSize,
  writeScaleFixture,
} from './generate-scale-fixture.mjs';

const { manifest, packages } = readNapiTargets(new URL('../package.json', import.meta.url));
const capabilityEvidence = JSON.parse(
  readFileSync(new URL('../scripts/assimp-capability-evidence.json', import.meta.url), 'utf8'),
);
const temporary = [];
const directory = (prefix) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
};
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('native target source', () => {
  it('defines exactly the requested targets and derives both workflow matrices from them', () => {
    assert.deepEqual(
      packages.map(({ triple }) => triple),
      ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'],
    );
    const { build, smoke } = nativeMatrices();
    assert.deepEqual(
      build.map(({ target }) => target),
      packages.map(({ triple }) => triple),
    );
    assert.equal(smoke.length, 12);
    assert.deepEqual(
      new Set(smoke.map(({ suffix }) => suffix)),
      new Set(packages.map(({ suffix }) => suffix)),
    );
    for (const node of NODE_VERSIONS) {
      assert.equal(smoke.filter((lane) => lane.runtime === 'node' && lane.node === node).length, 3);
    }
    assert.deepEqual(
      smoke.filter(({ scale }) => scale === '1'),
      [
        {
          lane: 'node-26',
          minScaleRssBytes: '4294967296',
          node: '26',
          os: 'ubuntu-24.04',
          runtime: 'node',
          scale: '1',
          scaleBytes: '536870912',
          suffix: 'linux-x64-gnu',
        },
      ],
    );
    assert.equal(smoke.filter((lane) => lane.runtime === 'electron' && lane.node === NODE_VERSION).length, 3);
    assert(smoke.filter(({ electron }) => electron === ELECTRON_VERSION).length === 3);
    assert.equal(manifest.devDependencies['@napi-rs/cli'], '3.8.6');
    assert.equal(manifest.devDependencies['cmake-js'], '8.0.0');
    assert.equal(manifest.devDependencies['node-addon-api'], '8.9.2');
    assert.deepEqual(manifest.binary.napi_versions, [8]);
    assert.equal(manifest.assimp.commit, capabilityEvidence.engineSha);
  });

  it('keeps workflows target-derived and release assembly ordered', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const action = readFileSync(
      new URL('../.github/actions/download-verified-artifact/action.yml', import.meta.url),
      'utf8',
    );
    const buildNative = readFileSync(new URL('../scripts/build-native.mjs', import.meta.url), 'utf8');
    const cmake = readFileSync(new URL('../CMakeLists.txt', import.meta.url), 'utf8');
    const buildNativeLines = new Set(buildNative.split('\n').map((line) => line.trim()));
    const cmakeLines = new Set(cmake.split('\n').map((line) => line.trim()));
    const exportsCheck = readFileSync(new URL('../scripts/check-cpp-exports.mjs', import.meta.url), 'utf8');
    const smoke = readFileSync(new URL('../scripts/test-package.mjs', import.meta.url), 'utf8');
    assert(workflow.includes('fromJSON(needs.preflight.outputs.build-matrix)'));
    assert(workflow.includes('fromJSON(needs.preflight.outputs.smoke-matrix)'));
    const workflowLines = workflow.split('\n');
    for (let index = 0; index < workflowLines.length; ++index) {
      if (workflowLines[index].trim() !== 'name: wasm') continue;
      if (workflowLines[index + 1]?.trim() !== 'path: src/wasm') continue;
      assert.equal(
        workflowLines[index + 2]?.trim(),
        'expect: libassimp.js libassimp.wasm libassimp.manifest.json',
      );
    }
    assert(!/^\s+- target: /mu.test(workflow));
    assert(workflow.includes('pnpm exec cmake-js print-cmakejs-lib'));
    assert(workflow.includes('run: pnpm run build:native -- --test'));
    assert(!workflow.includes('pnpm run build:native -- --target'));
    assert.equal(manifest.exports['.'].import.browser.default, './dist/index.mjs');
    assert.equal(manifest.exports['.'].import.node.default, './dist/index.node.mjs');
    assert.equal(manifest.exports['.'].import.node.types, './dist/index.node.d.mts');
    assert.deepEqual(Object.keys(manifest.exports['.'].import), ['browser', 'node', 'types', 'default']);
    assert(smoke.includes('utilityProcess.fork'));
    assert(smoke.includes("run(process.execPath, ['install.js']"));
    assert(smoke.includes("join(work, 'node_modules', 'electron', 'cli.js')"));
    assert(!smoke.includes('electron.cmd'));
    assert(smoke.includes("NAPI_RS_ENFORCE_VERSION_CHECK: '1'"));
    assert(!smoke.includes('ELECTRON_RUN_AS_NODE'));
    assert(buildNative.includes('nodeEnvironment.LD_PRELOAD'));
    assert(
      buildNativeLines.has(
        "nodeLibraryDefinition = resolve(nodeInclude.split(';')[0], '..', 'def', 'node_api.def');",
      ),
    );
    assert(buildNativeLines.has('`-DCMAKE_JS_NODELIB_DEF=${nodeLibraryDefinition}`,'));
    assert(cmakeLines.has('set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")'));
    assert(cmakeLines.has('if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)'));
    assert(
      cmakeLines.has(
        'separate_arguments(LIBASSIMP_STATIC_LINKER_OPTIONS NATIVE_COMMAND "${CMAKE_STATIC_LINKER_FLAGS}")',
      ),
    );
    assert(
      cmakeLines.has(
        'COMMAND "${CMAKE_AR}" /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${LIBASSIMP_STATIC_LINKER_OPTIONS}',
      ),
    );
    assert(cmake.includes('set(gtest_force_shared_crt OFF'));
    assert(action.includes("ANNOTATE: 'false'"));
    assert(workflow.includes('ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756'));
    assert(workflow.includes('LIBASSIMP_REGISTRY_VERSION: ${{ needs.preflight.outputs.version }}'));
    assert(workflow.includes("runner.os == 'Linux' && matrix.runtime == 'electron'"));
    assert(workflow.includes('LIBASSIMP_SCALE_BYTES: ${{ matrix.scaleBytes }}'));
    assert(workflow.includes('LIBASSIMP_MIN_SCALE_RSS_BYTES: ${{ matrix.minScaleRssBytes }}'));
    assert(!workflow.includes('linux-x64-napi8'));
    assert(workflow.includes('linux-x64-napi${LIBASSIMP_NAPI_VERSION}'));
    assert(exportsCheck.includes("['-D', '--defined-only', '-j', binary]"));
    assert(
      workflow.includes("required.push('publish', 'registry-verify', 'registry-smoke', 'registry-release')"),
    );
    for (const command of [
      'pnpm exec napi create-npm-dirs --npm-dir npm',
      'pnpm exec napi artifacts --output-dir native-artifacts --npm-dir npm',
      'node scripts/inspect-native.mjs',
      'pnpm exec napi pre-publish --skip-optional-publish -t npm --no-gh-release',
      'node scripts/check-prepared-release.mjs',
      'node scripts/pack-test-tarballs.mjs --out tarballs',
    ])
      assert(workflow.includes(command), command);
    assert(
      workflow.indexOf('pnpm exec napi pre-publish') <
        workflow.indexOf('node scripts/pack-test-tarballs.mjs'),
    );
    assert(workflow.includes('registry returned $name@$version without dist.integrity'));
    assert(workflow.indexOf('existing="$(npm view') < workflow.indexOf('npm publish'));
    assert(manifest.scripts.prepublishOnly.includes("process.env.GITHUB_ACTIONS!=='true'"));
    assert(manifest.scripts.prepublishOnly.includes('node scripts/check-prepared-release.mjs'));
    assert(manifest.scripts.prepublishOnly.endsWith('node scripts/validate-pack.mjs'));
  });

  it('delegates the ESM native loader to writeJsBinding', () => {
    const source = readFileSync(new URL('../scripts/write-native-loaders.mjs', import.meta.url), 'utf8');
    assert(source.includes("import { writeJsBinding } from '@napi-rs/cli'"));
    assert(source.includes("jsBinding: 'index.js'"));
    assert(source.includes('esm: true'));
    assert(!source.includes('index.cjs'));
    assert(!source.includes('process.platform'));
    for (const name of [
      'buildIdentity',
      'destroyPlan',
      'napiVersion',
      'packageVersion',
      'pendingName',
      'preparePlan',
      'runPlan',
      'supplyPlan',
      'takePlanResult',
    ]) {
      assert(source.includes(`'${name}'`), name);
    }
  });
});

describe('native binary inspection', () => {
  it('reads ELF, Mach-O, and PE machine headers without host-specific tools', () => {
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
    elf.writeUInt16LE(62, 18);
    const macho = Buffer.alloc(64);
    macho.writeUInt32LE(0xfeedfacf);
    macho.writeUInt32LE(0x0100000c, 4);
    const pe = Buffer.alloc(128);
    pe.write('MZ');
    pe.writeUInt32LE(64, 0x3c);
    pe.write('PE\0\0', 64, 'latin1');
    pe.writeUInt16LE(0x8664, 68);
    assert.deepEqual(inspectHeader(elf), { class: 64, format: 'elf', machine: 62 });
    assert.deepEqual(inspectHeader(macho), { class: 64, format: 'macho', machine: 0x0100000c });
    assert.deepEqual(inspectHeader(pe), { class: 64, format: 'pe', machine: 0x8664 });
  });

  it('finds the ELF dependency inventory and highest glibc requirement', () => {
    const output = `
      0x0000000000000001 (NEEDED) Shared library: [libstdc++.so.6]
      0x0000000000000001 (NEEDED) Shared library: [libc.so.6]
      Name: GLIBC_2.17  Flags: none  Version: 3
      Name: GLIBC_2.2.5 Flags: none  Version: 2
      Name: GLIBCXX_3.4.19 Flags: none Version: 4
      Name: GLIBCXX_3.4.9 Flags: none Version: 5
      Name: CXXABI_1.3.7 Flags: none Version: 6
      Name: CXXABI_1.3 Flags: none Version: 7
    `;
    assert.deepEqual(elfDependencies(output), ['libc.so.6', 'libstdc++.so.6']);
    assert.equal(maxGlibcVersion(output), '2.17');
    assert.equal(maxGlibcxxVersion(output), '3.4.19');
    assert.equal(maxCxxabiVersion(output), '1.3.7');
    assert.equal(maxGlibcVersion('no version requirements'), undefined);
    assert.equal(maxGlibcxxVersion('no version requirements'), undefined);
    assert.equal(maxCxxabiVersion('no version requirements'), undefined);
  });
});

describe('prepared release and tarball integrity set', () => {
  const createTree = () => {
    const root = directory('libassimp-prepared-');
    json(join(root, 'package.json'), {
      ...manifest,
      optionalDependencies: Object.fromEntries(packages.map(({ name }) => [name, manifest.version])),
    });
    mkdirSync(join(root, 'dist', 'native'), { recursive: true });
    writeFileSync(join(root, 'dist', 'native', 'index.js'), 'generated\n');
    for (const target of packages) {
      const targetDirectory = join(root, 'npm', target.suffix);
      mkdirSync(targetDirectory, { recursive: true });
      json(join(targetDirectory, 'package.json'), {
        cpu: [target.cpu],
        engines: manifest.engines,
        files: [target.binary],
        ...(target.libc ? { libc: [target.libc] } : {}),
        license: manifest.license,
        main: target.binary,
        name: target.name,
        os: [target.os],
        version: manifest.version,
      });
      writeFileSync(join(targetDirectory, target.binary), target.suffix);
      writeFileSync(join(targetDirectory, 'license'), 'Apache-2.0\n');
    }
    return root;
  };

  it('accepts the root plus exactly three licensed platform packages', () => {
    assert.deepEqual(preparedReleaseFindings({ packedFiles: PACKAGE_FILES, root: createTree() }), []);
  });

  it('records root plus three TGZ names, versions, and integrity values', () => {
    const root = createTree();
    const result = packTestTarballs({
      out: join(root, 'tarballs'),
      root,
      pack: (source) => {
        const suffix = source.split(/[/\\]/u).at(-1);
        const target = packages.find((entry) => entry.suffix === suffix);
        const name = target?.name ?? manifest.name;
        return {
          filename: `${name}-${manifest.version}.tgz`,
          integrity: `sha512-${Buffer.from(name).toString('base64')}`,
          name,
          size: name.length,
          version: manifest.version,
        };
      },
    });
    assert(!existsSync(join(root, 'test-tarballs.json')));
    assert.equal(Object.keys(result.packages).length, 4);
    assert.deepEqual(Object.keys(result.packages), Object.keys(result.packages).toSorted());
    assert.equal(result.packages.libassimp.size, manifest.name.length);
    for (const target of packages) {
      const candidate = result.packages[target.name];
      assert.deepEqual(candidate.target, {
        cpu: target.cpu,
        ...(target.libc === undefined ? {} : { libc: target.libc }),
        os: target.os,
        triple: target.triple,
      });
      assert.match(candidate.addonSha256, /^[\da-f]{64}$/u);
    }
  });
});

describe('deterministic scale fixture', () => {
  it('writes deterministic binary PLY geometry at the requested scale', () => {
    assert.equal(SCALE_BYTES, 67_108_864);
    assert(scalePointCountForSize(SCALE_BYTES) > 5_000_000);
    const first = join(directory('libassimp-scale-a-'), 'scale.ply');
    const second = join(directory('libassimp-scale-b-'), 'scale.ply');
    const firstSize = writeScaleFixture(first, 65_537);
    const secondSize = writeScaleFixture(second, 65_537);
    const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(digest(first), digest(second));
    assert.equal(firstSize, secondSize);
    assert(firstSize >= 65_537 && firstSize < 65_537 + 12);
    assert.equal(readScalePointCount(readFileSync(first)), scalePointCountForSize(65_537));
  });
});

describe('registry convergence', () => {
  const tarballs = {
    packages: {
      libassimp: { integrity: 'sha512-root', version: '1.0.0' },
      'libassimp-linux-x64-gnu': { integrity: 'sha512-linux', version: '1.0.0' },
    },
  };

  it('waits for matching bytes and attestations for every tarball', async () => {
    let attempt = 0;
    const logs = [];
    await waitForRegistry({
      log: (line) => logs.push(line),
      now: () => 0,
      sleep: async () => {
        attempt += 1;
      },
      tarballs,
      view: (name) =>
        attempt === 0
          ? null
          : {
              dist: {
                attestations: {
                  provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
                  url: 'https://registry.npmjs.org/-/npm/v1/attestations/libassimp@1.0.0',
                },
                integrity: tarballs.packages[name].integrity,
              },
            },
    });
    assert.deepEqual(logs, ['attempt 1: 0/2 packages available', 'attempt 2: 2/2 packages available']);
  });

  it('keeps missing and empty attestation metadata pending', async () => {
    for (const attestations of [undefined, {}]) {
      await assert.rejects(
        waitForRegistry({
          now: () => 0,
          tarballs,
          timeoutMs: 0,
          view: (name) => ({
            dist: { attestations, integrity: tarballs.packages[name].integrity },
          }),
        }),
        /timed out waiting for/u,
      );
    }
  });

  it('fails closed on different registry bytes', async () => {
    await assert.rejects(
      waitForRegistry({
        tarballs,
        view: () => ({ dist: { integrity: 'sha512-different' } }),
      }),
      /integrity differs/u,
    );
  });
});
