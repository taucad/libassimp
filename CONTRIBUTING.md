# Contributing

1. Fork or branch from `main`.
2. Install with `pnpm install --frozen-lockfile`.
3. Add tests that assert the changed public behavior.
4. Run `pnpm nx run libassimp:quality`. It expects the `assimp` submodule
   checked out (`git submodule update --init assimp`), because the format
   matrix reads the engine's fixture corpus, and `src/wasm/` populated. Without
   Docker, `pnpm run fetch:wasm` downloads the `wasm` artifact of the latest
   green `main` CI run (`-- --run <id>` picks another run, such as your pull
   request's). It needs `GH_TOKEN`, `GITHUB_TOKEN` or a signed-in `gh`, and
   warns when the artifact's engine commit differs from your submodule. With
   Docker, `pnpm run build:wasm` builds it. The tests read `dist/`, so the
   `test` target builds first.
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
   the pull request which formats moved and why. Wasm records; CI's smoke job
   runs the same suite on each native target with
   `pnpm exec vitest run --config vitest.native.config.ts` (after
   `pnpm run build` and copying the target's addon into `dist/native/`) and
   requires the same fingerprints. A native difference is fixed at its source;
   only an engine-side cause may become a `PARITY_EXCEPTIONS` entry, with its
   reason and platforms.
9. Move `bench/baselines.json` only in the pull request that causes the move.
   Download the `native-wasm-benchmark` artifact from that pull request's CI
   run and record its three USD reports with
   `pnpm run benchmark:record -- <reports> --origin "<what moved and why>"`.
   Tolerances change only as a reviewed edit with a measured origin; never
   re-record to turn a red gate green.
10. Read the format-matrix comment on performance or engine pull requests. It
    measures every fixture against every export target, plus 1024 x 1024 grids
    of each mesh format, for the base and the PR on one runner, and fails only
    when a cell crashes in the PR but not in the base. Reproduce a cell with
    `node bench/matrix.mjs --backend wasm|native --tier small|large --out report.json`
    (add `--filter <regex>`), and compare two reports with
    `node bench/matrix-report.mjs base=<before.json> pr=<after.json>`.
11. Open a pull request with commands and results.

Adding a format the engine supports is an edit to `assimp-builds.json`, which the
CMake presets and the docs matrix read. The export unions in `src/formats.ts`
are asserted against the compiled build, so a build that gained a format fails
a test until the union names it.

Only GitHub Actions publishes npm packages, creates tags or releases, and
deploys documentation. Never run `npm publish` from a workstation.
