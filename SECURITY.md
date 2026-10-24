# Security

## Reporting a vulnerability

Do not open public issues for vulnerabilities. Use GitHub's private
vulnerability reporting for `taucad/libassimp`.

Supported releases are the latest stable version. Reports should include the
affected version, host, reproduction, and expected impact. Maintainers will
acknowledge a report, coordinate a fix, and publish through the normal signed
CI release pipeline.

## Threat model

libassimp parses 3D files with assimp, a C++ engine with about 70 importers,
many of them for legacy formats. Treat every model file from a user, an upload
or the network as hostile. The engine was written to read well-formed files,
and the adversarial suite (`tests/adversarial-parity.mjs`) still finds inputs
that crash it, hang it or exhaust its memory. The `KNOWN_FAILURES` table in
`tests/adversarial-cases.mjs` lists them.

### Assets and attacker

The attacker controls the bytes and the names of the files passed to
`convert`, and every name those files reference (`mtllib`, USD asset paths, glTF
URIs). The attacker does not control the options or the resolver. The assets
are the host process, its memory and CPU, and whatever the resolver can read.

### What each backend guarantees

| Property                             | Wasm (`backend: 'wasm'`)                                                 | Native (`backend: 'native'`, the Node default under `auto`)                                     |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Memory corruption in the engine      | Contained in the module's linear memory; host memory is safe             | Runs inside your process: arbitrary memory corruption is possible                               |
| Engine crash (stack overflow, abort) | The call rejects; the process survives                                   | The process dies (SIGSEGV, SIGABRT)                                                             |
| Memory exhaustion                    | Bounded by the 4 GB Wasm heap; the call rejects                          | Unbounded; the OS may kill the process                                                          |
| CPU exhaustion (a hang)              | Blocks the thread that runs the module                                   | Blocks a libuv worker thread                                                                    |
| File system and network              | None: the module sees only the bytes you pass and what `resolve` returns | Same API surface, but a memory-safety bug runs with the process's rights                        |
| Hardening                            | Wasm bounds checks and control-flow integrity                            | Stack protector, `_FORTIFY_SOURCE=2`, full RELRO (Linux), CFG and Spectre mitigations (Windows) |

### Recommendations

1. **Use the Wasm backend for untrusted input.** Pass `backend: 'wasm'` to
   `createAssimp`. A failure becomes a rejected promise instead of a dead
   process.
2. **Isolate it further for services.** Run conversions in a worker thread, a
   child process or an Electron utility process. Put a deadline on each job
   and abort it with an `AbortSignal`; terminate the worker when a
   conversion hangs, because a running engine call cannot be interrupted.
3. **Use native only in a child or utility process** if you need its speed for
   untrusted files. Restart it when it exits, and give it an OS memory limit
   (cgroups, `ulimit -v`, a job object).
4. **Cap the input.** libassimp has no input, output or memory limits of its
   own. Check file sizes before calling `convert`, and run the conversion
   where an oversized allocation cannot hurt other work.
5. **Contain the resolver.** The names your resolver receives are written by
   the attacker. Resolve them inside one directory, reject absolute paths and
   `..` segments, and never fetch arbitrary URLs.

### Known attack classes

- **Deep nesting.** A glTF with a 20,000-deep node chain (409 KB) overflows the
  native stack and kills the process; Wasm rejects with a `RangeError`. FBX
  scopes, COLLADA nodes and JSON arrays behave the same way.
- **Decompression bombs.** USDZ, 3MF, ZAE and PK3 are ZIP archives, and FBX
  arrays are zlib streams. A 1 MB archive can inflate to 1 GB. The suite feeds
  1 GiB bombs to both backends; the engine rejects most of them, and the PK3
  importer inflates the whole entry before failing.
- **Oversized counts.** Headers that declare billions of vertices make the
  engine allocate before it reads. Native reports `IMPORT_FAILED`; Wasm can
  abort with an untyped `RuntimeError`.
- **Truncated and garbage files.** Several legacy importers crash or loop on
  damaged input.
- **Resolver traversal.** See "Contain the resolver" under Recommendations.

### How the project tests this

- `tests/adversarial-parity.mjs` runs every hostile input through both
  backends on every native target in CI and requires the same verdict: both
  convert, or both reject with the same `AssimpError` code. Large inputs are
  generated at test time.
- `.github/workflows/fuzz.yml` runs a libFuzzer harness over the C++ conversion
  pipeline with AddressSanitizer and UndefinedBehaviorSanitizer every night,
  seeded with `tests/fuzz/corpus`, and uploads every crash as an artifact.
- Every release carries a CycloneDX SBOM (`libassimp.cdx.json`) on its GitHub
  release, attested against the npm tarballs. OSV scans the npm lockfile and
  the engine's C/C++ commit pins (`osv-cpp-pins.json`).
