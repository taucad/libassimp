#!/usr/bin/env bash
# Build another revision's TypeScript facade around its prebuilt Wasm pair, so
# bench/matrix.mjs can measure it beside the checked-out build. Prints the
# entry to pass as `--build name=<entry>`; the revision's native addon is
# passed separately as `addon=`.
# Usage: bench/prepare-build.sh <directory> <revision> <directory holding libassimp.js and libassimp.wasm>

set -euo pipefail

directory="$1"
revision="$2"
wasm="$(cd "$3" && pwd)"

git worktree add --detach "$directory" "$revision" >&2
cd "$directory"
pnpm install --frozen-lockfile >&2
pnpm exec tsdown >&2
node scripts/write-native-loaders.mjs >&2
mkdir -p dist/wasm
cp "$wasm/libassimp.js" "$wasm/libassimp.wasm" dist/wasm/
echo "$PWD/dist/index.node.mjs"
