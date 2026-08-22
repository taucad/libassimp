# Contributing

1. Fork or branch from `main`.
2. Install with `pnpm install --frozen-lockfile`.
3. Add tests that assert the changed public behavior.
4. Run `pnpm nx run libassimp:quality`. It expects `src/wasm/` to be populated:
   build it with `pnpm run build:wasm -- --all`, or download the `wasm-*`
   artifacts from a CI run.
5. Add a Version Plan with `pnpm nx release plan` when package behavior or
   shipped artifacts change. Pending plans feed an automated release pull
   request; a maintainer merges it to publish.
6. Update a byte budget in the causing pull request when the larger artifact is
   intentional. Explain the measured origin beside the threshold.
7. Rename the gated benchmark when its semantics change; do not overwrite its
   identity to hide a new workload.
8. Open a pull request with commands and results.

Adding a format the engine supports is an edit to `variants.json`: the CMake
presets, the exported format union, and the docs matrix all read it.

Only GitHub Actions publishes npm packages, creates tags or releases, and
deploys documentation. Never run `npm publish` from a workstation.
