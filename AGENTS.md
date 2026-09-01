# AGENTS.md

## Commands

```bash
pnpm nx run libassimp:quality
pnpm nx run libassimp:test
pnpm nx run libassimp:build
pnpm nx run libassimp:validate-pack
```

## Architecture

`src/` is the ESM TypeScript facade: one `index` entry over the shared
`create-assimp` module, which loads `libassimp.wasm` through a bundler-opaque
glue import. `src/cpp/` is the embind
binding — one `convert` free function that returns copied bytes, so no handle
ever reaches a consumer. `assimp/` is the engine, a git submodule tracking
`taucad/assimp`.

`assimp-builds.json` is the single source for the production and native-test format sets.
`scripts/assimp-builds-to-presets.mjs` derives `CMakePresets.json` from it and the
docs format matrix reads it, so adding a format the engine gained is one JSON
edit; the export unions in `src/formats.ts` are asserted against the compiled
build rather than derived from it.

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
