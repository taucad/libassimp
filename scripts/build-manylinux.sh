#!/usr/bin/env bash
# Build the glibc 2.17 linux-x64 addon inside the pinned manylinux2014 image.
# The image digest is part of the addon's CI cache key through this file.
# Usage: scripts/build-manylinux.sh <node-include-dir> <output-dir relative to the repo root>
#
# This lane compiles without ccache: the pinned ccache needs glibc 2.28, and
# EPEL's ccache 3.7 rejects CMake's launcher as a recursive invocation. The
# workflow's addon cache skips this build whenever its inputs are unchanged.

set -euo pipefail

image='quay.io/pypa/manylinux2014_x86_64@sha256:f6077fab327d7823d7cee287b93ef63efe3af0e234add7503121247c1475ebec'
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_include="$1"
output="$2"

cmake -E remove_directory "$root/.node-headers"
cmake -E make_directory "$root/.node-headers" "$root/$output"
cp -R "$node_include/." "$root/.node-headers/"
napi_version="$(node -p "require('$root/package.json').binary.napi_versions[0]")"

# shellcheck disable=SC2016 # Expanded by the container's shell.
docker run --rm --user "$(id -u):$(id -g)" --volume "$root:/src" --workdir /src \
  --env HOME=/tmp --env "OUTPUT=$output" --env "LIBASSIMP_NAPI_VERSION=$napi_version" \
  "$image" bash -lc '
    cmake --preset native -G "Unix Makefiles" -B build/native-manylinux \
      -DNODE_ADDON_API_DIR=/src/node_modules/node-addon-api \
      -DCMAKE_JS_INC=/src/.node-headers -DCMAKE_JS_LIB= -DCMAKE_JS_SRC= \
      -DCMAKE_JS_OUTPUT_DIR="/src/$OUTPUT" \
      -DLIBASSIMP_NATIVE_BUILD_IDENTITY="linux-x64-napi${LIBASSIMP_NAPI_VERSION}" \
      -DLIBASSIMP_NATIVE_TESTS=OFF -DLIBASSIMP_NATIVE_ADDON=ON &&
      cmake --build build/native-manylinux --parallel "$(nproc)" &&
      strip --strip-unneeded "/src/$OUTPUT/libassimp.node"
  '
