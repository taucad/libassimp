# libassimp

[![npm](https://img.shields.io/npm/v/libassimp)](https://www.npmjs.com/package/libassimp)
[![CI](https://github.com/taucad/libassimp/actions/workflows/ci.yml/badge.svg)](https://github.com/taucad/libassimp/actions/workflows/ci.yml)

Assimp compiled to WebAssembly: typed conversion among 40+ 3D formats in Node.js, browsers, and workers.

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

const response = await fetch('https://assets.example/model.gltf');
const bytes = new Uint8Array(await response.arrayBuffer());
const { files } = await convert(
  { name: 'model.gltf', bytes },
  {
    to: 'glb',
    resolve: async (name) => {
      const sidecar = await fetch(new URL(name, response.url));
      return sidecar.ok ? new Uint8Array(await sidecar.arrayBuffer()) : undefined;
    },
  },
);
```

The same artifact automatically suspends with JSPI when the host supports it and transparently replays from a per-call resolver cache otherwise. `createAssimp` still accepts only `wasmUrl`, `wasmBinary`, and `onLog`.

## Static capabilities

`assimpCapabilities`, `conversionEdges`, and `defaultPostProcess` are generated from the pinned Assimp source and are available without loading Wasm. Public targets are canonical: binary/ASCII choices use `exportOptions.binary`, OBJ materials use `exportOptions.materials`, and `glb`/`gltf` always mean glTF 2.

The single `libassimp` entry reads all 69 compiled extensions and writes all 15 canonical formats through `libassimp.wasm`.

## Compatibility

See the canonical [compatibility matrix](compatibility.md) for hosts, package entries, JSPI acceleration, replay fallback, and Wasm feature floors.

## Versioning and stability

The package is prerelease. Public names, defaults, and generated capability metadata are reviewed API; see [breaking changes](BREAKING_CHANGES.md).

## Security and provenance

Releases are built by GitHub Actions with npm provenance. Report vulnerabilities through [the security policy](SECURITY.md).

## Documentation

Read the [documentation](https://libassimp.vercel.app), [contribution guide](CONTRIBUTING.md), or [maintainer guide](MAINTAINER.md).

## License

Apache-2.0. Part of the [Tau ecosystem](https://tau.new).
