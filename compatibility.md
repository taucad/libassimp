# Compatibility

This file is the canonical host and WebAssembly feature matrix. Other docs link here rather than duplicating floors.

| Host             | Supported floor | CI evidence                                | Async resolver route                             |
| ---------------- | --------------- | ------------------------------------------ | ------------------------------------------------ |
| Node.js          | 22.14.0         | `node (22.14.0)`, `node (24)`, `node (26)` | replay                                           |
| Chromium         | Chrome 95       | `browser (chromium)`                       | JSPI when both host APIs exist; replay otherwise |
| Firefox          | Firefox 100     | `browser (firefox)`                        | replay until JSPI is available                   |
| WebKit           | Safari 16.4     | `browser (webkit)`                         | replay until JSPI is available                   |
| Linux x64 native | test-only       | `native`                                   | native resolver harness                          |

Every entry ships one Wasm artifact. At instantiation, libassimp detects `WebAssembly.Suspending` and `WebAssembly.promising`; when both exist it uses JSPI, and otherwise uses an immediate-abort, promise-cache replay path. Both routes expose the same Promise API and are byte-for-byte parity tested on the same finalized artifact.

Artifacts use Emscripten 6.0, fixed SIMD (`-msimd128`), Wasm exceptions (`-fwasm-exceptions`), and the explicit legacy-EH pin `-sWASM_LEGACY_EXCEPTIONS=1`. Exnref is intentionally deferred until every supported floor reaches Chrome 137, Firefox 131, Safari 18.4, and Node 24.15. Asyncify, pthreads, relaxed SIMD, and JSPI-specific artifacts are not shipped.

The native row is not a published runtime: it compiles the same C++ binding with the host toolchain so engine and lifetime regressions fail before Emscripten packaging.
