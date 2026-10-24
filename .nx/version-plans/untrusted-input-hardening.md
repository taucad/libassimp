---
libassimp: patch
---

Harden the native addons and document untrusted input. Every native build compiles the engine with `-fstack-protector-strong` and `_FORTIFY_SOURCE=2` and links with full RELRO on Linux, and with Control Flow Guard and Spectre mitigations on Windows. The Wasm link fails on any undefined symbol instead of shipping a runtime abort stub. `SECURITY.md` and the new "Untrusted input" guide give the threat model: use `backend: 'wasm'` (or an isolated child process) for files you did not write. Each release carries a CycloneDX SBOM of the npm and C/C++ dependencies, attested against the npm tarballs, and OSV scans the engine's C/C++ commit pins.
