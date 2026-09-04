---
__default__: minor
---

Add native Node-API packages for Apple silicon macOS, x64 glibc Linux, and x64 Windows while retaining the browser WebAssembly entry. Async sidecars use one `ResolveFile` contract with optional cancellation: native and JSPI preserve one import, while non-JSPI Wasm alone can replay N+1 times for N asynchronously discovered sidecars. Ambiguous sidecar basenames now require an exact path or resolver result instead of silently selecting the first match.
