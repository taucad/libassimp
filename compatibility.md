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

Source builds use a maintained Assimp fork with boolean specialized progress callbacks and Assimp ABI 7. Rebuild C++ consumers and return the cancellation decision from specialized overrides; this engine ABI change does not change the public Node-API or TypeScript contract.

Node defaults to `backend: 'auto'`: it loads the matching native package and emits a warning before Wasm fallback. Use `backend: 'native'` when a packaged desktop application must fail loudly if its addon was not staged, or `backend: 'wasm'` for reference and parity runs. The returned instance exposes the selected backend and the native build identity when applicable.

`ResolveFile` is the only public sidecar-loading flow. Native and JSPI suspend the active plan and finish all dependency requests within one Assimp import. The non-JSPI Wasm fallback alone reconstructs attempt-local Assimp state after each newly resolved dependency, so N asynchronously discovered sidecars can require N+1 imports in the worst case. Its per-call cache still invokes the resolver at most once for each distinct requested name. Supplying known sidecars in the initial file list avoids resolver calls and replay.

Conversion options accept an optional `AbortSignal` and reject with its reason. A pre-aborted or queued request stops before plan admission. Aborting a pending resolver releases the conversion without waiting for its Promise; stopping the underlying provider I/O requires that I/O to observe the same signal. Cancellation after engine admission is cooperative: native work checks Assimp progress checkpoints, while synchronous Wasm can observe cancellation only when control returns to the host. It is not a hard interrupt of arbitrary importer or exporter code.

Native conversions are admitted by one process-wide serial executor because Assimp has process-global state. The executor covers all instances and Node worker threads, and waiting conversions do not occupy the shared filesystem, crypto, DNS, and zlib pool. Separate Wasm instances remain independent. Plan-owned bytes, resolver references, and native handles are released through the same deterministic cleanup path after success, failure, cancellation, or disposal.

Queued native requests retain JavaScript input views without eagerly copying their bytes into C++. The admitted job copies on its originating JavaScript thread before engine execution. Keep input bytes unchanged until settlement; detaching or resizing a queued input to a different length fails safely at admission.

A pending native resolver retains the executor slot, so untrusted provider work needs a caller-owned cancellation deadline. There is no implicit timeout or in-process parallel import. Separate utility processes provide independent progress and hard termination. Instance disposal drains accepted work rather than cancelling it.

A native resolver must not await another native conversion: both need the same executor. Calls started in the resolver's own asynchronous context are rejected before staging; a separate forced-Wasm instance can perform independent nested work. Pre-created Promise chains and cross-worker message/RPC dependency cycles are outside this detection and require caller-owned deadlines. An unrelated native request can still queue while a resolver is pending.

Native address space is not limited to Wasm32's 4 GiB, but file-format limits still apply. USDZ uses classic ZIP: layouts requiring ZIP64 are rejected before payload copying rather than silently truncating sizes or offsets. Larger native memory capacity does not imply unlimited output size for every format.

The compiled importer catalog lists recognized extensions, not support for every encoding. Assimp recognizes `x3db` but has no binary X3D decoder. Native and Wasm reject binary X3D with `IMPORT_FAILED`; an empty result is not a successful decode. XML X3D remains supported, including a valid empty scene.
