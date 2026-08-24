<h1 align="center">
  <img src="images/banner.svg" alt="libassimp" width="100%">
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/libassimp"><img src="https://img.shields.io/npm/v/libassimp?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/taucad/libassimp/actions/workflows/ci.yml"><img src="https://github.com/taucad/libassimp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://tau.new"><img src="https://img.shields.io/badge/Tau-ecosystem-6d28d9" alt="Part of the Tau ecosystem"></a>
</p>

Assimp compiled to WebAssembly: import 40+ 3D formats and export glTF, 3MF, USD, FBX, STL and more.

| I want to…               | Start here                                                          |
| ------------------------ | ------------------------------------------------------------------- |
| Install the package      | [Install](#install)                                                 |
| Run the smallest example | [Quick start](#quick-start)                                         |
| Choose a supported host  | [Compatibility](#compatibility)                                     |
| Contribute or release    | [CONTRIBUTING.md](CONTRIBUTING.md) / [MAINTAINER.md](MAINTAINER.md) |

## Install

```bash
npm install libassimp
```

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

Three entries ship the same API and differ only in the formats compiled in:
`libassimp` imports and exports everything, `libassimp/importer` carries every
importer with the glTF exporters, and `libassimp/exporter` carries every
exporter with the glTF importers. Import the narrowest one that covers the
conversion to ship the smallest binary.

## Compatibility

See [compatibility.md](compatibility.md). Every check mark in that table maps
to a named job in `.github/workflows/ci.yml`.

## Versioning and stability

Versions follow Semantic Versioning. Before 1.0, a minor release may contain a
breaking API change; each major line records those changes in
[BREAKING_CHANGES.md](BREAKING_CHANGES.md).

## Security and provenance

Report vulnerabilities through GitHub private vulnerability reporting. Verify
registry signatures with `npm audit signatures`.

## Documentation

- [Documentation](https://libassimp.vercel.app)
- [Source](https://github.com/taucad/libassimp)
- [Changelog](CHANGELOG.md)
- [Issues](https://github.com/taucad/libassimp/issues)

## License

Apache-2.0. See [license](license) and [NOTICE](NOTICE) for bundled materials.

Part of the [Tau ecosystem](https://tau.new).
