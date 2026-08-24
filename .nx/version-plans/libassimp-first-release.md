---
libassimp: minor
---

First release: `libassimp` 0.1.0 — the `taucad/assimp` engine at `c06c37a38`, compiled to WebAssembly with Emscripten 6.0.8. The full, importer, and exporter entries expose compiler-derived typed capabilities and static conversion edges, canonical glTF 2 formats, exact import/export/post-process options, and stable `/wasm` subpaths. `convert` and positional `convertFormats` support import-once/export-many conversion, ordered sidecars, atomic failures, lifecycle-safe instances, and direct or promised dependency resolution. Each entry ships one baseline artifact that automatically uses JSPI when available and deterministic replay otherwise.
