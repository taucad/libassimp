# Breaking changes

## Unreleased prerelease API

- Replaced raw `properties` with generated `importOptions`, named `postProcess` steps, and target-specific `exportOptions`.
- Consolidated native exporter aliases into 13 canonical targets. Use `binary` for FBX/PLY/STL encoding, `materials: false` for OBJ without MTL, `step` instead of `stp`, and `dae` instead of `collada`.
- Removed glTF 1 import/export and the public `glb1`, `gltf1`, `glb2`, and `gltf2` names. `glb` and `gltf` always mean glTF 2.
- Added positional `convertFormats`; no public target/result ID is accepted.
- Made `resolve` Promise-capable on every supported host.
- Added optional `AbortSignal` cancellation to `convert` and `convertFormats`; `ResolveFile` remains a one-argument callback and can close over the same signal for cancellable I/O.
- Native and JSPI resolution now preserve a single import. Only non-JSPI Wasm can replay an import N+1 times for N asynchronously discovered sidecars.
- Removed DirectX X, X3D (with VRML `wrl`/`x3dv`) and Autodesk 3DS import and export to cut the Wasm size. The `x`, `x3d` and `3ds` export targets are gone, and files in these formats now reject with `IMPORT_FAILED`. ASE import is unaffected.
- Split `FormatInfo` into directional `ImportFormatInfo` and `ExportFormatInfo`, and added static `conversionEdges` and `assimpCapabilities`.
- Removed `libassimp/importer`, `libassimp/exporter`, and their `/wasm` subpaths. Use the complete root entry and the sole `libassimp/wasm` artifact.
- USD export options follow the LightUSD exporter: `materialX`, `subdivision`, `volumes` and `optimizeForMobile` are gone (the exporter writes UsdPreviewSurface materials, never subdivides, and always applies the ARKit profile to USDZ). New: `animationIndex`, `maxFileSizeMb` and `maxMemoryMb` on every USD target, `compressFloatArrays` on `usdc` and `usdz`, and `lights` and `physicsJoints` on `usdz`. A new `usdc` target writes binary USD.
- USD exports keep UVs unflipped and author `metersPerUnit` instead of baking unit scale into geometry, so USD output bytes and transforms differ from earlier builds.

No released stable version is affected.
