---
libassimp: minor
---

First release: `libassimp` 0.1.0 — the `taucad/assimp` engine at `c06c37a38`, compiled to WebAssembly with Emscripten 6.0.8. The full, importer, and exporter entries expose compiler-derived typed capabilities, static conversion edges, canonical glTF 2 formats, exact options, and stable `/wasm` subpaths. `convert` and `convertFormats` support import-once/export-many conversion, ordered sidecars, atomic failures, lifecycle-safe instances, and synchronous or asynchronous dependency resolution. One baseline artifact per entry uses JSPI when available and deterministic replay otherwise. Prerelease review closure hardens fork-safe security scanning, demo resource ownership, sidecar containment, validation, shared-instance retry, target-attributed errors, unsigned Wasm offsets, and package/test integrity.
