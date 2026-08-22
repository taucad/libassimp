# Contributing

1. Fork or branch from `main`.
2. Install with `pnpm install --frozen-lockfile`.
3. Add tests that assert the changed public behavior.
4. Run `pnpm nx run libassimp:quality`. It expects the `assimp` submodule
   checked out, because the format matrix reads the engine's fixture corpus,
   and `src/wasm/` populated: build it with `pnpm run build:wasm -- --all`, or
   download the `wasm-*` artifacts from a CI run. The tests read `dist/`, so
   the `test` target builds first.
5. Add a Version Plan with `pnpm nx release plan` when package behavior or
   shipped artifacts change. Pending plans feed an automated release pull
   request; a maintainer merges it to publish.
6. Update a byte budget in the causing pull request when the larger artifact is
   intentional. Explain the measured origin beside the threshold.
7. Rename the gated benchmark when its semantics change; do not overwrite its
   identity to hide a new workload.
8. Re-record `tests/determinism.json` with
   `LIBASSIMP_RECORD_DETERMINISM=1 pnpm exec vitest run tests/format-matrix.test.mjs`
   when an engine or exporter change alters output bytes on purpose, and say in
   the pull request which formats moved and why.
9. Open a pull request with commands and results.

Adding a format the engine supports is an edit to `variants.json`, which the
CMake presets and the docs matrix read. The export unions in `src/formats.ts`
are asserted against the compiled build, so a build that gained a format fails
a test until the union names it.

Only GitHub Actions publishes npm packages, creates tags or releases, and
deploys documentation. Never run `npm publish` from a workstation.
