# Compatibility

This file is the canonical host and WebAssembly feature matrix. Other docs link here rather than duplicating floors.

| Host                        | Supported floor                                         | Runtime package            | CI evidence                                   |
| --------------------------- | ------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| Node.js on macOS arm64      | Node 22.14.0; macOS 11.0                                | `libassimp-darwin-arm64`   | Node 22.14.0/24/26 and Electron 38.7.2 smokes |
| Node.js on Linux x64 glibc  | Node 22.14.0; glibc 2.17; GLIBCXX 3.4.19; CXXABI 1.3.7  | `libassimp-linux-x64-gnu`  | Node 22.14.0/24/26 and Electron 38.7.2 smokes |
| Node.js on Windows x64 MSVC | Node 22.14.0; no separate VC++ redistributable required | `libassimp-win32-x64-msvc` | Node 22.14.0/24/26 and Electron 38.7.2 smokes |
| Chromium                    | Chrome 95                                               | root WebAssembly artifact  | `browser (chromium)`                          |
| Firefox                     | Firefox 100                                             | root WebAssembly artifact  | `browser (firefox)`                           |
| WebKit                      | Safari 16.4                                             | root WebAssembly artifact  | `browser (webkit)`                            |

The package ships one `libassimp.wasm` artifact. At instantiation, libassimp detects `WebAssembly.Suspending` and `WebAssembly.promising`; when both exist it uses JSPI, and otherwise uses an immediate-abort, promise-cache replay path. Both routes expose the same Promise API and are byte-for-byte parity tested on the same finalized artifact.

Artifacts use Emscripten 6.0, fixed SIMD (`-msimd128`), Wasm exceptions (`-fwasm-exceptions`), and the explicit legacy-EH pin `-sWASM_LEGACY_EXCEPTIONS=1`. Exnref is intentionally deferred until every supported floor reaches Chrome 137, Firefox 131, Safari 18.4, and Node 24.15. Asyncify, pthreads, relaxed SIMD, and JSPI-specific artifacts are not shipped.

The three native packages use Node-API rather than the Node or Electron module ABI. Other CPU, libc, and operating-system combinations are not silently compiled during installation; use the WebAssembly entry in a supported browser or contribute an explicitly built and tested target.

Node defaults to `backend: 'auto'`: it loads the matching native package and emits a warning before Wasm fallback. Use `backend: 'native'` when a packaged desktop application must fail loudly if its addon was not staged, or `backend: 'wasm'` for reference and parity runs. The returned instance exposes the selected backend and the native build identity when applicable.

Native conversions are admitted process-serial because Assimp has process-global state. The addon's process-wide dispatcher queues only one conversion into libuv at a time, including across Node worker threads, so waiting conversions do not occupy the shared filesystem, crypto, DNS, and zlib pool. Separate Wasm instances remain independent.

Native async resolution discovers one uncached sidecar per replay, so an input with N uncached sidecars can require N+1 imports. Provide known sidecars in the initial file set; batch discovery should replace replay only if multi-sidecar profiles show it is material.
