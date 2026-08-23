# Compatibility

| Host             | Supported | CI evidence          |
| ---------------- | --------- | -------------------- |
| Node 22.14.0     | ✅        | `node (22.14.0)`     |
| Node 24          | ✅        | `node (24)`          |
| Node 26          | ✅        | `node (26)`          |
| Chromium         | ✅        | `browser (chromium)` |
| Firefox          | ✅        | `browser (firefox)`  |
| WebKit           | ✅        | `browser (webkit)`   |
| Linux x64 native | ✅        | `native`             |

The wasm is built with Emscripten 6.0. Its SIMD and legacy WebAssembly
exception-handling features set the browser floors at Chrome 95, Firefox 100,
and Safari 16.4. Exnref is not used because Node 22 and Safari before 18.4 do
not support it. The `native` row is not a shipped host: it is the same C++
binding built with the host toolchain and exercised by `ctest`, so an engine
regression is caught without waiting for an Emscripten build.
