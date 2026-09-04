# libassimp

[![npm](https://img.shields.io/npm/v/libassimp)](https://www.npmjs.com/package/libassimp)
[![CI](https://github.com/taucad/libassimp/actions/workflows/ci.yml/badge.svg)](https://github.com/taucad/libassimp/actions/workflows/ci.yml)

Assimp for TypeScript and WebAssembly: import 69 3D formats and export 15 formats in browsers and Node.js. Node loads a platform-native Node-API addon when one of the supported native packages is available; browsers retain the WebAssembly implementation.

| I want to…                             | Start here                                                          |
| -------------------------------------- | ------------------------------------------------------------------- |
| Convert one model                      | [Quick start](#quick-start)                                         |
| Export several formats from one import | [Import once, export many](#import-once-export-many)                |
| Load sidecars over a network           | [Resolve sidecars asynchronously](#resolve-sidecars-asynchronously) |
| Build a dynamic converter UI           | [Static capabilities](#static-capabilities)                         |
| Maintain or release the package        | [Maintainer guide](MAINTAINER.md)                                   |

## Install

```bash
pnpm add libassimp
```

## Quick start

```typescript
import { convert } from 'libassimp';
import { readFile, writeFile } from 'node:fs/promises';

const bytes = new Uint8Array(await readFile('model.obj'));
const { files } = await convert({ name: 'model.obj', bytes }, { to: 'glb' });
await writeFile(files[0].name, files[0].bytes);
```

## Import once, export many

```typescript
import { convertFormats } from 'libassimp';
import { readFile } from 'node:fs/promises';

const bytes = new Uint8Array(await readFile('model.fbx'));
const [glb, binaryStl, obj] = await convertFormats(
  { name: 'model.fbx', bytes },
  {
    targets: [
      { to: 'glb' },
      { to: 'stl', exportOptions: { binary: true } },
      { to: 'obj', exportOptions: { materials: false } },
    ],
  },
);

console.log(glb.format, binaryStl.format, obj.files[0].name);
```

The positional result tuple preserves target order and literal format types. The source is copied and parsed once; exports run sequentially and the call is atomic.

## Resolve sidecars asynchronously

```typescript
import { convert } from 'libassimp';

const controller = new AbortController();
const response = await fetch('https://assets.example/model.gltf', { signal: controller.signal });
const bytes = new Uint8Array(await response.arrayBuffer());
const { files } = await convert(
  { name: 'model.gltf', bytes },
  {
    to: 'glb',
    signal: controller.signal,
    resolve: async (name) => {
      const sidecar = await fetch(new URL(name, response.url), { signal: controller.signal });
      return sidecar.ok ? new Uint8Array(await sidecar.arrayBuffer()) : undefined;
    },
  },
);
```

`resolve` is the one dependency-loading flow on every backend, and each requested name is cached for the call. Native and JSPI keep one Assimp import alive while dependencies resolve. Only non-JSPI Wasm replays: N asynchronously discovered sidecars can require N+1 imports in the worst case.

The `signal` is optional. Aborting releases a pending conversion without waiting for the resolver Promise; pass the same signal to resolver I/O, as above, to stop that I/O too. Cancellation is cooperative once engine work is running, so settlement can wait for the next native progress checkpoint or return from synchronous Wasm. Success, failure, and cancellation release plan-owned bytes and resolver state deterministically. `dispose()` rejects new calls and drains accepted calls; it does not cancel them.

In Node, `createAssimp({ backend: 'auto' | 'native' | 'wasm' })` makes routing explicit and the returned instance reports the backend it loaded. `auto` warns before falling back to Wasm when the matching optional native package is unavailable. All native instances and Node worker threads share one process-wide serial executor; separate Wasm instances remain independent.

An unresolved native sidecar holds that executor's slot. For untrusted Node I/O, pass a caller-chosen deadline such as `signal: AbortSignal.timeout(30_000)`; cancelling the blocked call releases the slot. libassimp imposes no hidden deadline on large conversions. Use separate utility processes when workloads need independent progress or hard termination.

## Static capabilities

`assimpCapabilities`, `conversionEdges`, and `defaultPostProcess` are generated from the pinned Assimp source and are available without loading Wasm. Public targets are canonical: binary/ASCII choices use `exportOptions.binary`, OBJ materials use `exportOptions.materials`, and `glb`/`gltf` always mean glTF 2.

The single `libassimp` entry reads all 69 compiled extensions and writes all 15 canonical formats through the host-selected backend.

On Node.js, the same entry selects one generated optional package: `libassimp-darwin-arm64`, `libassimp-linux-x64-gnu`, or `libassimp-win32-x64-msvc`. The host selection code is generated by the pinned NAPI-RS CLI. No install script compiles code on a consumer machine.

## Compatibility

See the canonical [compatibility matrix](compatibility.md) for hosts, package entries, JSPI acceleration, replay fallback, and Wasm feature floors.

## Versioning and stability

The package is prerelease. Public names, defaults, and generated capability metadata are reviewed API; see [breaking changes](BREAKING_CHANGES.md).

## Security and provenance

GitHub Actions builds and inspects each native binary, assembles generated licensed platform packages, and smokes the exact integrity-pinned tarballs in clean Node and Electron installs. Releases publish the three platform packages before the root package with npm OIDC provenance, then verify registry bytes, signatures, and attestations. Report vulnerabilities through [the security policy](SECURITY.md).

## Documentation

Read the [documentation](https://libassimp.xyz), [contribution guide](CONTRIBUTING.md), or [maintainer guide](MAINTAINER.md).

## License

Apache-2.0. Part of the [Tau ecosystem](https://tau.new).
