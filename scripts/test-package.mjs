#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_PACKAGE = 'libassimp';
const INSTALL_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'];
const smokeEnvironment = { ...process.env, NAPI_RS_ENFORCE_VERSION_CHECK: '1' };

export const requireNativeSuffix = (environment) => {
  const suffix = environment['LIBASSIMP_NATIVE_SUFFIX'];
  if (!suffix || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(suffix)) {
    throw new Error('LIBASSIMP_NATIVE_SUFFIX must name a platform package suffix');
  }
  return suffix;
};

export const resolveSmokeMode = (environment) => {
  const directory = environment['LIBASSIMP_TARBALL_DIR'];
  const version = environment['LIBASSIMP_REGISTRY_VERSION'];
  if (Number(Boolean(directory)) + Number(Boolean(version)) !== 1) {
    throw new Error('set exactly one of LIBASSIMP_TARBALL_DIR or LIBASSIMP_REGISTRY_VERSION');
  }
  return directory ? { directory: resolve(directory), kind: 'tarball' } : { kind: 'registry', version };
};

export const selectTarballs = (manifest, suffix) => {
  const platformName = `${ROOT_PACKAGE}-${suffix}`;
  const entry = (name) => {
    const packed = manifest.packages?.[name];
    if (!packed || packed.version !== manifest.version || !packed.filename) {
      throw new Error(`the frozen manifest has no valid tarball for ${name}`);
    }
    return packed.filename;
  };
  return {
    platformName,
    platformTarball: entry(platformName),
    rootTarball: entry(ROOT_PACKAGE),
    version: manifest.version,
  };
};

const run = (command, arguments_, options) =>
  execFileSync(command, arguments_, {
    ...options,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
const suffix = requireNativeSuffix(process.env);
const mode = resolveSmokeMode(process.env);
const work = mkdtempSync(join(tmpdir(), 'libassimp-package-'));

try {
  writeFileSync(join(work, 'package.json'), '{"private":true,"type":"module"}\n');
  let configuredNames;
  if (mode.kind === 'tarball') {
    if (!existsSync(join(mode.directory, 'test-tarballs.json'))) {
      throw new Error(`no test-tarballs.json in ${mode.directory}`);
    }
    const manifest = JSON.parse(readFileSync(join(mode.directory, 'test-tarballs.json'), 'utf8'));
    const selected = selectTarballs(manifest, suffix);
    configuredNames = Object.keys(manifest.packages).filter((name) => name !== ROOT_PACKAGE);
    run(
      'npm',
      [
        'install',
        ...INSTALL_FLAGS,
        join(mode.directory, selected.rootTarball),
        join(mode.directory, selected.platformTarball),
      ],
      { cwd: work },
    );
  } else {
    run('npm', ['install', ...INSTALL_FLAGS, `${ROOT_PACKAGE}@${mode.version}`], { cwd: work });
    configuredNames = Object.keys(
      JSON.parse(readFileSync(join(work, 'node_modules', ROOT_PACKAGE, 'package.json'), 'utf8'))
        .optionalDependencies ?? {},
    );
  }

  const installed = readdirSync(join(work, 'node_modules')).filter((name) => configuredNames.includes(name));
  if (!installed.includes(`${ROOT_PACKAGE}-${suffix}`)) {
    throw new Error(
      `expected ${ROOT_PACKAGE}-${suffix}; installed ${installed.join(', ') || 'no platform package'}`,
    );
  }

  const fixture = fileURLToPath(new URL('../tests/fixtures/cube.obj', import.meta.url));
  const materialFixture = fileURLToPath(new URL('../tests/fixtures/cube-material.obj', import.meta.url));
  const materialSidecar = fileURLToPath(new URL('../tests/fixtures/cube-material.mtl', import.meta.url));
  const scale = process.env['LIBASSIMP_SCALE'] === '1' ? join(work, 'scale.ply') : '';
  if (scale) {
    run(process.execPath, [
      fileURLToPath(new URL('../tests/generate-scale-fixture.mjs', import.meta.url)),
      scale,
    ]);
  }
  writeFileSync(
    join(work, 'consumer.mjs'),
    `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const native = await import('libassimp');
const packageRoot = new URL('./node_modules/libassimp/', pathToFileURL(process.cwd() + '/'));
const wasm = await import(new URL('dist/index.mjs', packageRoot));
const bytes = new Uint8Array(await readFile(process.argv[2]));
const request = [{ name: 'cube.obj', bytes }, { to: 'glb' }];
const glbPointCount = (contents) => {
  const view = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(16, true), 0x4e4f534a);
  const document = JSON.parse(new TextDecoder().decode(contents.subarray(20, 20 + view.getUint32(12, true))));
  return document.meshes.reduce((total, mesh) => total + mesh.primitives.reduce((sum, primitive) => {
    assert.equal(primitive.mode, 0);
    return sum + document.accessors[primitive.attributes.POSITION].count;
  }, 0), 0);
};
const nativeAssimp = await native.createAssimp({ backend: 'native' });
const wasmAssimp = await wasm.createAssimp({ backend: 'wasm' });
assert.equal(nativeAssimp.backend, 'native');
const [nativeResult, wasmResult] = await Promise.all([nativeAssimp.convert(...request), wasmAssimp.convert(...request)]);
assert.deepEqual(nativeResult, wasmResult, 'native/Wasm bytes differ');
assert.equal(Buffer.from(nativeResult.files[0].bytes.subarray(0, 4)).toString('latin1'), 'glTF');
const materialObj = new Uint8Array(await readFile(process.argv[4]));
const materialBytes = new Uint8Array(await readFile(process.argv[5]));
let resolverCalls = 0;
const resolve = async (name) => {
  resolverCalls += 1;
  return name === 'cube-material.mtl' ? materialBytes : undefined;
};
const sidecarRequest = [{ name: 'cube-material.obj', bytes: materialObj }, { to: 'glb', resolve }];
const nativeSidecar = await nativeAssimp.convert(...sidecarRequest);
assert.equal(resolverCalls, 1);
resolverCalls = 0;
const wasmSidecar = await wasmAssimp.convert(...sidecarRequest);
assert.equal(resolverCalls, 1);
assert.deepEqual(nativeSidecar, wasmSidecar, 'sidecar native/Wasm bytes differ');
const targets = [{ to: 'glb' }, { to: 'stl', exportOptions: { binary: true } }, { to: 'assjson' }];
const [nativeFormats, wasmFormats] = await Promise.all([
  nativeAssimp.convertFormats({ name: 'cube.obj', bytes }, { targets }),
  wasmAssimp.convertFormats({ name: 'cube.obj', bytes }, { targets }),
]);
assert.deepEqual(nativeFormats, wasmFormats, 'multi-output native/Wasm bytes differ');
assert.deepEqual(nativeFormats.map(({ format }) => format), ['glb', 'stl', 'assjson']);
for (const backend of [nativeAssimp, wasmAssimp]) await assert.rejects(backend.convert({ name: 'bad.obj', bytes: new Uint8Array([0]) }, { to: 'glb' }));
const instance = await native.createAssimp({ backend: 'native' });
instance.dispose();
await assert.rejects(instance.convert({ name: 'cube.obj', bytes }, { to: 'glb' }), /disposed/iu);
if (process.argv[3]) {
  const large = new Uint8Array(await readFile(process.argv[3]));
  const vertexLine = Buffer.from(large.buffer, large.byteOffset, Math.min(large.byteLength, 512)).toString('utf8').split('\\n').find((line) => line.startsWith('element vertex '));
  const points = Number(vertexLine?.slice('element vertex '.length));
  assert(Number.isSafeInteger(points) && points > 0);
  let ticked = false;
  const pending = nativeAssimp.convert({ name: 'scale.ply', bytes: large }, { to: 'glb' });
  setImmediate(() => { ticked = true; });
  const converted = await pending;
  assert(ticked, 'native conversion blocked the event loop');
  assert.equal(glbPointCount(converted.files[0].bytes), points);
  const maxResidentBytes = process.resourceUsage().maxRSS * 1024;
  const minimumResidentBytes = Number(process.env.LIBASSIMP_MIN_SCALE_RSS_BYTES ?? 0);
  assert(maxResidentBytes >= minimumResidentBytes, \`peak RSS \${maxResidentBytes} did not reach \${minimumResidentBytes}\`);
  console.log(JSON.stringify({ inputBytes: large.byteLength, maxResidentBytes, points }));
}
nativeAssimp.dispose();
wasmAssimp.dispose();
console.log('native/Wasm parity, malformed input, lifecycle, and subprocess smoke passed');
if (process.parentPort !== undefined) process.exit(0);
`,
  );

  if (process.env['LIBASSIMP_RUNTIME'] === 'electron') {
    const version = process.env['LIBASSIMP_ELECTRON_VERSION'];
    if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) {
      throw new Error('LIBASSIMP_ELECTRON_VERSION must be exact SemVer');
    }
    writeFileSync(
      join(work, 'electron-main.mjs'),
      `
import { app, utilityProcess } from 'electron';
import { join } from 'node:path';

const readyTimeout = setTimeout(() => {
  console.error('Electron did not become ready within 30 seconds');
  app.exit(1);
}, 30_000);
app.whenReady().then(() => {
  clearTimeout(readyTimeout);
  const smokeArgs = JSON.parse(process.env.LIBASSIMP_ELECTRON_SMOKE_ARGS ?? '[]');
  const child = utilityProcess.fork(join(process.cwd(), 'consumer.mjs'), smokeArgs, {
    serviceName: 'libassimp-native-smoke',
    stdio: 'pipe',
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  const childTimeout = setTimeout(() => {
    console.error('Electron utility-process smoke exceeded 120 seconds');
    child.kill();
    app.exit(1);
  }, 120_000);
  child.once('error', (error) => {
    clearTimeout(childTimeout);
    console.error(error);
    app.exit(1);
  });
  child.once('exit', (code) => {
    clearTimeout(childTimeout);
    app.exit(code ?? 1);
  });
});
`,
    );
    const configuredElectron = process.env['LIBASSIMP_ELECTRON_BINARY'];
    if (configuredElectron === undefined) {
      run(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          `electron@${version}`,
        ],
        { cwd: work },
      );
      run(process.execPath, ['install.js'], { cwd: join(work, 'node_modules', 'electron') });
    }
    const electron =
      configuredElectron === undefined
        ? join(work, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
        : resolve(configuredElectron);
    const actualVersion = execFileSync(electron, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
    if (actualVersion !== `v${version}`) {
      throw new Error(`expected Electron v${version}, received ${actualVersion}`);
    }
    const arguments_ = [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--headless',
      'electron-main.mjs',
    ];
    const options = {
      cwd: work,
      env: {
        ...smokeEnvironment,
        LIBASSIMP_ELECTRON_SMOKE_ARGS: JSON.stringify([fixture, scale, materialFixture, materialSidecar]),
      },
      timeout: 180_000,
    };
    if (process.platform === 'linux') run('xvfb-run', ['-a', electron, ...arguments_], options);
    else run(electron, arguments_, options);
  } else {
    run(process.execPath, ['consumer.mjs', fixture, scale, materialFixture, materialSidecar], {
      cwd: work,
      env: smokeEnvironment,
    });
  }
  process.stdout.write(`clean ${process.env['LIBASSIMP_RUNTIME'] ?? 'node'} smoke passed for ${suffix}\n`);
} finally {
  rmSync(work, { force: true, recursive: true });
}
