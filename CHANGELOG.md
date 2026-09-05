## 0.3.0 (2026-09-05)

### 🚀 Features

- Add native Node-API packages for Apple silicon macOS, x64 glibc Linux, and x64 Windows while retaining the browser WebAssembly entry. Async sidecars use one `ResolveFile` contract with optional cancellation: native and JSPI preserve one import, while non-JSPI Wasm alone can replay N+1 times for N asynchronously discovered sidecars. Ambiguous sidecar basenames now require an exact path or resolver result instead of silently selecting the first match. ([#31](https://github.com/taucad/libassimp/pull/31))

### ❤️ Thank You

- Claude Fable 5.1
- Richard Fontein @rifont

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
