# Breaking changes

## Unreleased prerelease API

- Replaced raw `properties` with generated `importOptions`, named `postProcess` steps, and target-specific `exportOptions`.
- Consolidated native exporter aliases into 15 canonical targets. Use `binary` for FBX/PLY/STL encoding, `materials: false` for OBJ without MTL, `step` instead of `stp`, and `dae` instead of `collada`.
- Removed glTF 1 import/export and the public `glb1`, `gltf1`, `glb2`, and `gltf2` names. `glb` and `gltf` always mean glTF 2.
- Added positional `convertFormats`; no public target/result ID is accepted.
- Made `resolve` Promise-capable on every supported host.
- Added optional `AbortSignal` cancellation to `convert` and `convertFormats`; `ResolveFile` remains a one-argument callback and can close over the same signal for cancellable I/O.
- Native and JSPI resolution now preserve a single import. Only non-JSPI Wasm can replay an import N+1 times for N asynchronously discovered sidecars.
- Split `FormatInfo` into directional `ImportFormatInfo` and `ExportFormatInfo`, and added static `conversionEdges` and `assimpCapabilities`.
- Removed `libassimp/importer`, `libassimp/exporter`, and their `/wasm` subpaths. Use the complete root entry and the sole `libassimp/wasm` artifact.

No released stable version is affected.
