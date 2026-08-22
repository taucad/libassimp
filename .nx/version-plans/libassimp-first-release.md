---
libassimp: minor
---

First release: `libassimp` 0.1.0 — Assimp (the `taucad/assimp` engine, `24c936c16`) compiled to WebAssembly with Emscripten 6.0.8. Entries `libassimp` (every importer and exporter), `libassimp/importer` (every importer, glTF/assjson export), and `libassimp/exporter` (glTF/USD import, every exporter), each with a `/wasm` subpath. API: `convert(files, { to, resolve, properties })` one-shot, `createAssimp()` instances with `dispose`/`using`, `AssimpError` with `NO_FILES`/`UNSUPPORTED_FORMAT`/`IMPORT_FAILED`/`EXPORT_FAILED`, per-entry `ExportFormat` unions, results as plain copied bytes.
