# Breaking changes

Before 1.0, a minor version may break the API. Each section lists what breaks in that release, relative to the one before it. Tau and other callers pinned with `^0.x` do not pick up a new minor automatically.

## 0.4.0 (unreleased)

- USD export options follow the LightUSD exporter: `materialX`, `subdivision`, `volumes` and `optimizeForMobile` are gone, and passing one rejects with `INVALID_OPTIONS` (the exporter writes UsdPreviewSurface materials, never subdivides, and always applies the ARKit profile to USDZ). New: `animationIndex`, `maxFileSizeMb` and `maxMemoryMb` on every USD target, `compressFloatArrays` on `usdc` and `usdz`, and `lights` and `physicsJoints` on `usdz`. A new `usdc` target writes binary USD.
- USD exports keep UVs unflipped and author `metersPerUnit` instead of baking unit scale into geometry, so USD output bytes, texture coordinates and transforms differ from 0.3.
- Removed DirectX X, X3D (with VRML `wrl`/`x3dv`) and Autodesk 3DS import and export to cut the Wasm size. The `x`, `x3d` and `3ds` export targets are gone, and files in these formats now reject with `IMPORT_FAILED`. ASE import is unaffected.
- The root entry's `assimpCapabilities` no longer carries prose: `OptionDescriptor` and `PostProcessDescriptor` lose `description`. Import `assimpCapabilities` from `libassimp/capabilities` for the same registry with descriptions.
- Outputs are named after the entry file's stem with the canonical extension (`chair.obj` to `step` gives `chair.step`), replacing the fixed `result.<ext>` names; `step` output now ends in `.step`. Sidecars an exporter derives from the primary name (glTF `.bin`, OBJ `.mtl`, COLLADA textures, USDZ members) follow it, so their names and the bytes that reference them change.
- `dispose()` returns a Promise that settles after queued work drains. `using` still works; `await using` waits for the drain.
- A native backend that cannot load reports `BACKEND_UNAVAILABLE` (was `IMPORT_FAILED`). Untyped engine throws reject as `ENGINE_FAILED` with the original value as `cause`. New codes: `LIMIT_EXCEEDED`, `ABORTED`, `INTERNAL`.
- Empty or repeated input names reject with `INVALID_OPTIONS`.
- Unset `AssimpError` context fields (`formatIndex`, `format`, `fileName`) are absent instead of present as `undefined`.
- Output bytes are typed `Uint8Array<ArrayBuffer>`. In the browser entry the buffer is always fixed-length; on Node.js a Wasm output's buffer may be resizable.
- The native addon's `importFormats` and `exportFormats` exports are removed; use `assimpCapabilities`.

Saved options that contain a removed key fail strict validation. The [0.4 upgrade guide](https://libassimp.xyz/docs/guides/upgrade-to-0-4) shows how to strip them.

## 0.3.0

- Added optional `AbortSignal` cancellation to `convert` and `convertFormats`; `ResolveFile` remains a one-argument callback and can close over the same signal for cancellable I/O.
- Native and JSPI resolution now preserve a single import. Only non-JSPI Wasm can replay an import N+1 times for N asynchronously discovered sidecars.
- Binary X3D now reports `IMPORT_FAILED` instead of an empty successful result. The engine recognizes its extension but has no binary decoder; XML X3D is unaffected.

## 0.2.0

No breaking changes.

## 0.1.0

The first release, relative to the unpublished prerelease builds:

- Replaced raw `properties` with generated `importOptions`, named `postProcess` steps, and target-specific `exportOptions`.
- Consolidated native exporter aliases into 15 canonical targets. Use `binary` for FBX/PLY/STL encoding, `materials: false` for OBJ without MTL, `step` instead of `stp`, and `dae` instead of `collada`.
- Removed glTF 1 import/export and the public `glb1`, `gltf1`, `glb2`, and `gltf2` names. `glb` and `gltf` always mean glTF 2.
- Added positional `convertFormats`; no public target/result ID is accepted.
- Made `resolve` Promise-capable on every supported host.
- Split `FormatInfo` into directional `ImportFormatInfo` and `ExportFormatInfo`, and added static `conversionEdges` and `assimpCapabilities`.
- Removed `libassimp/importer`, `libassimp/exporter`, and their `/wasm` subpaths. Use the complete root entry and the sole `libassimp/wasm` artifact.
