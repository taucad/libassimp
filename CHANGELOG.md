## 0.4.0 (2026-10-26)

### 🚀 Features

- Move option and post-process descriptions out of the root entry into a new lazy `libassimp/capabilities` subpath, which exports the same `assimpCapabilities` registry with a `description` on every option and step. The root entry's static JavaScript shrinks from 218.2 kB to 79.3 kB (43.0 kB to 15.2 kB gzip), and descriptions no longer repeat their type and default.

  The format matrix, determinism fingerprints and USD suite now run on the native backend as well as Wasm, with every remaining difference documented in the test. esbuild's default browser build no longer fails on the Node-only `node:fs/promises` import, and CI now installs the packed tarball into Vite, webpack 5, Next.js (Turbopack), esbuild and a CDN-style host and converts a model in Chromium in each. ([#57](https://github.com/taucad/libassimp/pull/57))
- Stream converted output to the host instead of assembling it in the engine, and report what happened during a conversion. Wasm output chunks land in a resizable host buffer, returned without a final join on Node.js and moved to a fixed-length buffer in browsers, whose Web APIs reject resizable views; native output bytes are handed to JavaScript without a copy. With JSPI or native, the engine frees the entry file once it is imported.

  Every result now carries `warnings`, per-phase `timings` and `peakMemoryBytes`, and `onProgress` reports throttled `import`, `postProcess` and `export` progress on both backends. Allocation failure reports `LIMIT_EXCEEDED` and leaves the instance usable, a Wasm runtime that traps is replaced on the next conversion, and `recycleAboveBytes` lets any instance drop a large idle Wasm heap. Node.js gains `createDirectoryResolver(root)`, a sidecar resolver confined to one directory. ([#57](https://github.com/taucad/libassimp/pull/57))

  Breaking: outputs are named after the entry file's stem with the target's canonical extension (`chair.obj` to `step` gives `chair.step`, not `result.stp`), so USDZ members and every sidecar reference change bytes too, and output bytes are typed `Uint8Array<ArrayBuffer>` (on Node.js a Wasm output's buffer may be resizable). `dispose()` returns a Promise that settles after queued work drains.

  A native backend that cannot load reports `BACKEND_UNAVAILABLE` instead of `IMPORT_FAILED`, and anything the engine throws that is not already an `AssimpError` rejects as `ENGINE_FAILED` with the original value as `cause`; `LIMIT_EXCEEDED`, `ABORTED` and `INTERNAL` are also new codes. Empty or repeated input names reject with `INVALID_OPTIONS`. Unset `AssimpError` context fields are absent rather than `undefined`. The native addon no longer exports `importFormats` or `exportFormats`; use `assimpCapabilities`.

- Move the USD importer and exporter to LightUSD (the successor to TinyUSDZ) and add the `usdc` export target. USD sublayers, references and payloads, including USDA, USDC and MaterialX sidecars, resolve through `resolve`, and a composed scene exports as a self-contained USDZ that passes OpenUSD's ARKit compliance checks. Large USD scenes convert several times faster in a fraction of the memory.

  The Node-API worker gets an 8 MiB stack, Wasm `dispose` releases the instance's memory, and the module-level `convert` recycles its shared Wasm instance after a job grows linear memory past 512 MiB. ([#47](https://github.com/taucad/libassimp/pull/47))

  **Breaking.** The USD export options `materialX`, `subdivision`, `volumes` and `optimizeForMobile` are removed, and passing one now rejects with `INVALID_OPTIONS`; strip them from saved settings before upgrading (see the 0.4 upgrade guide). USD output changes for the same input: UVs are no longer flipped, and the exporters author `metersPerUnit` on the stage instead of baking the unit scale into geometry, so USD bytes, texture coordinates and transforms differ from 0.3.

- Exports are faster and use less memory. A GLB or glTF export keeps the imported scene's shared vertices indexed instead of writing every triangle corner out separately. Exporters that only read the scene no longer copy it first. Vertex joining uses a hash table, the OBJ, STL, PLY, COLLADA and STEP writers stream their text, the glTF buffer grows geometrically, and a GLB's binary chunk is read in place.

  STEP output no longer depends on memory addresses, and a point-cloud PLY now exports to STL and PLY. The new 3MF export option `requireManifold` (default `true`) can be set to `false` to write open surfaces as 3MF objects of type `other` instead of failing.

  Files whose scene graph nests deeper than 1000 levels, or whose nodes form a cycle, are rejected with `IMPORT_FAILED` instead of overflowing the stack. 3MF and COLLADA files with out-of-range indices are rejected the same way instead of being read out of bounds. ([#57](https://github.com/taucad/libassimp/pull/57))

### 🩹 Fixes

- The Wasm build uses dlmalloc instead of mimalloc: the binary is 60 kB smaller and large conversions reach a 12–52% lower linear-memory high-water mark at the same speed, which leaves more of the 4 GiB limit for the input. The native addon is built with link-time optimization, shrinking it from 30.5 MB to about 19 MB. ([#57](https://github.com/taucad/libassimp/pull/57))
- The Windows native addon also allocates through mimalloc, which makes large conversions about 6–16% faster with byte-identical output, for 4–16% more peak memory. macOS keeps the system allocator. ([#57](https://github.com/taucad/libassimp/pull/57))
- Harden the native addons and document untrusted input. Every native build compiles the engine with `-fstack-protector-strong` and `_FORTIFY_SOURCE=2` and links with full RELRO on Linux, and with Control Flow Guard and Spectre mitigations on Windows. The Wasm link fails on any undefined symbol instead of shipping a runtime abort stub. `SECURITY.md` and the new "Untrusted input" guide give the threat model: use `backend: 'wasm'` (or an isolated child process) for files you did not write.

  Each release carries a CycloneDX SBOM of the npm and C/C++ dependencies, attested against the npm tarballs, and OSV scans the engine's C/C++ commit pins. ([#57](https://github.com/taucad/libassimp/pull/57))
- Publish installable package previews for same-repository pull requests, verify the hosted root and native-package graph before merge, and refresh security-sensitive build dependencies. ([#37](https://github.com/taucad/libassimp/pull/37))
- OBJ files import as indexed meshes: face corners that share a position, texture coordinate and normal share one vertex. Converting a 1024 × 1024 OBJ grid to GLB peaks about 19% lower in memory with byte-identical output. Face-normal generation no longer reads past the end of a mesh's texture coordinates, colours or tangents when it splits a shared vertex. ([#57](https://github.com/taucad/libassimp/pull/57))
- The Linux native addon allocates through mimalloc and links libstdc++ statically, which makes large conversions about 8–14% faster with byte-identical output, for 2–4% more peak memory. The addon no longer depends on the system `libstdc++.so.6`. ([#57](https://github.com/taucad/libassimp/pull/57))

### ❤️ Thank You

- Claude
- Claude Opus 5.5 (1M context)
- Richard Fontein @rifont

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
