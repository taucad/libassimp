# AGENTS.md

## Commands

```bash
pnpm nx run libassimp:quality
pnpm nx run libassimp:test
pnpm nx run libassimp:build
pnpm nx run libassimp:validate-pack
```

## Architecture

`src/` is the ESM TypeScript facade: one package entry conditionally selects
Node-API or the single Wasm artifact. Both use `create-assimp`, one
`ResolutionContext`, and the private C++ `Plan`/`MemoryFiles` pipeline.
Native uses one process-wide executor and thread-safe resolver callbacks;
JSPI suspends Wasm in place, and only non-JSPI Wasm replays. Consumers receive
copied bytes, never native handles. `assimp/` is the engine submodule tracking
`taucad/assimp`.

`assimp-builds.json` is the single source for the production and native-test format sets.
`scripts/assimp-builds-to-presets.mjs` derives `CMakePresets.json` from it and the
docs format matrix reads it. `scripts/generate-assimp-capabilities.mjs`
generates the public registry and types from checked compiler evidence and
semantic overrides; compiled-format tests verify the resulting surface.

`scripts/build-wasm.mjs` runs the digest-pinned toolchain from
`emsdk-image.txt` and writes `src/wasm/`, which is git-ignored and CI-built:
`ci.yml`'s `build-wasm` job is the only place Wasm is produced, and
`validate-pack` asserts the glue and binary are present in the candidate
tarball. `docs-site/` is a static Fumadocs site generated from the public
TypeScript exports.

## Conventions

- ESM-only public API through package exports.
- Keep `unbundle: true`; binary URL resolution depends on relative output.
- Public exports require stable JSDoc and consumer-shape tests.
- GitHub Actions is the sole npm publisher.
- Every compatibility check mark maps to a CI job.
- Admission changes are explicit budget or benchmark-identity diffs. The
  budgets in `.size-limit.json`, `scripts/check-wasm-size.mjs`, and
  `bench/gated.mjs` are the first production build's measurements plus stated
  headroom, and `tests/determinism.json` pins the output bytes; each moves only
  in the pull request that causes the move.
- Bump `emsdk-image.txt` and the `container:` literals in the workflows
  together; `pnpm run workflows` asserts they stay equal.

## Skills

| Skill               | When to use                                      |
| ------------------- | ------------------------------------------------ |
| `release-libassimp` | Auditing or preparing a reviewed package release |
