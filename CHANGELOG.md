## 0.2.0 (2026-09-01)

### 🚀 Features

- Preserve EXT_mesh_manifold topology and material runs when exporting glTF to 3MF. ([#24](https://github.com/taucad/libassimp/pull/24))

### ❤️ Thank You

- Richard Fontein @rifont

## 0.1.0 (2026-08-25)

### 🚀 Features

- First release: `libassimp` 0.1.0 compiles the `taucad/assimp` engine at `c06c37a38` to one optimized `libassimp.wasm` artifact with Emscripten 6.0.8. The root entry exposes compiler-derived typed capabilities, static conversion edges, canonical glTF 2 formats, and exact options. `convert` and `convertFormats` support import-once/export-many conversion, ordered sidecars, atomic failures, lifecycle-safe instances, and synchronous or asynchronous dependency resolution. The same artifact uses JSPI when available and deterministic replay otherwise. Prerelease review closure hardens security scanning, demo resource ownership, sidecar containment, validation, shared-instance retry, target-attributed errors, unsigned Wasm offsets, and package integrity. ([#11](https://github.com/taucad/libassimp/pull/11))

### ❤️ Thank You

- Richard Fontein @rifont

# Changelog

Release entries are generated from Nx Version Plans.
