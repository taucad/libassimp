# Breaking changes

## Unreleased prerelease API

- Replaced raw `properties` with generated `importOptions`, named `postProcess` steps, and target-specific `exportOptions`.
- Consolidated native exporter aliases into 15 canonical targets. Use `binary` for FBX/PLY/STL encoding, `materials: false` for OBJ without MTL, `step` instead of `stp`, and `dae` instead of `collada`.
- Removed glTF 1 import/export and the public `glb1`, `gltf1`, `glb2`, and `gltf2` names. `glb` and `gltf` always mean glTF 2.
- Added positional `convertFormats`; no public target/result ID is accepted.
- Made `resolve` Promise-capable on every supported host.
- Added optional `AbortSignal` cancellation to `convert` and `convertFormats`; `ResolveFile` remains a one-argument callback and can close over the same signal for cancellable I/O.
- Native and JSPI resolution now preserve a single import. Only non-JSPI Wasm can replay an import N+1 times for N asynchronously discovered sidecars.
- Binary X3D now reports `IMPORT_FAILED` instead of an empty successful result. The engine recognizes its extension but has no binary decoder; XML X3D is unaffected.
- Split `FormatInfo` into directional `ImportFormatInfo` and `ExportFormatInfo`, and added static `conversionEdges` and `assimpCapabilities`.
- Removed `libassimp/importer`, `libassimp/exporter`, and their `/wasm` subpaths. Use the complete root entry and the sole `libassimp/wasm` artifact.
- USD export options follow the LightUSD exporter: `materialX`, `subdivision`, `volumes` and `optimizeForMobile` are gone (the exporter writes UsdPreviewSurface materials, never subdivides, and always applies the ARKit profile to USDZ). New: `animationIndex`, `maxFileSizeMb` and `maxMemoryMb` on every USD target, `compressFloatArrays` on `usdc` and `usdz`, and `lights` and `physicsJoints` on `usdz`. A new `usdc` target writes binary USD.
- USD exports keep UVs unflipped and author `metersPerUnit` instead of baking unit scale into geometry, so USD output bytes and transforms differ from earlier builds.
- Outputs are named after the entry file's stem with the canonical extension (`chair.obj` to `step` gives `chair.step`), replacing the fixed `result.<ext>` names; `step` output now ends in `.step`. Sidecars an exporter derives from the primary name (glTF `.bin`, OBJ `.mtl`, COLLADA textures, USDZ members) follow it, so their names and the bytes that reference them change.
- `dispose()` returns a Promise that settles after queued work drains. `using` still works; `await using` waits for the drain.
- A native backend that cannot load reports `BACKEND_UNAVAILABLE` (was `IMPORT_FAILED`). Untyped engine throws reject as `ENGINE_FAILED` with the original value as `cause`. New codes: `LIMIT_EXCEEDED`, `ABORTED`, `INTERNAL`.
- Empty or repeated input names reject with `INVALID_OPTIONS`.
- Unset `AssimpError` context fields (`formatIndex`, `format`, `fileName`) are absent instead of present as `undefined`.
- Output bytes are typed `Uint8Array<ArrayBuffer>`; a Wasm output's buffer may be resizable.
- The native addon's `importFormats` and `exportFormats` exports are removed; use `assimpCapabilities`.

No released stable version is affected.
