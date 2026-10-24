#!/usr/bin/env bash
# Build the glibc 2.17 linux-x64 addon inside the pinned manylinux2014 image.
# The image digest is part of the addon's CI cache key through this file.
# Usage: scripts/build-manylinux.sh <node-include-dir> <output-dir relative to the repo root>

set -euo pipefail

image='quay.io/pypa/manylinux2014_x86_64@sha256:f6077fab327d7823d7cee287b93ef63efe3af0e234add7503121247c1475ebec'
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_include="$1"
output="$2"

cmake -E remove_directory "$root/.node-headers"
cmake -E make_directory "$root/.node-headers" "$root/$output" "$root/.ccache"
cp -R "$node_include/." "$root/.node-headers/"
napi_version="$(node -p "require('$root/package.json').binary.napi_versions[0]")"

# The container runs as root so it can install ccache, then hands every file it
# wrote back to the runner user. ccache is optional: the image's yum mirrors are
# best effort and a cold compile is still correct. CCACHE_DIR sits in the
# mounted workspace so the workflow can restore and save it.
# shellcheck disable=SC2016 # Expanded by the container's shell.
docker run --rm --volume "$root:/src" --workdir /src \
  --env HOME=/tmp --env "HOST_OWNER=$(id -u):$(id -g)" --env "OUTPUT=$output" \
  --env "LIBASSIMP_NAPI_VERSION=$napi_version" \
  --env CCACHE_DIR=/src/.ccache --env CCACHE_BASEDIR=/src --env CCACHE_NOHASHDIR=true \
  --env CCACHE_COMPILERCHECK=content --env CCACHE_MAXSIZE=1G \
  "$image" bash -lc '
    # The login profile can put ccache masquerade links first on PATH; with an
    # explicit launcher those recurse, so the build sees only real compilers.
    PATH="$(printf %s "$PATH" | tr : "\n" | grep -v ccache | paste -sd :)"
    launcher=""
    if yum install -y -q ccache >/dev/null 2>&1 ||
      { yum install -y -q epel-release >/dev/null 2>&1 && yum install -y -q ccache >/dev/null 2>&1; }; then
      launcher=ccache
      ccache --zero-stats >/dev/null
    else
      echo "::warning::ccache is unavailable in the manylinux image; compiling cold"
    fi
    status=0
    cmake --preset native -G "Unix Makefiles" -B build/native-manylinux \
      -DCMAKE_C_COMPILER_LAUNCHER="$launcher" -DCMAKE_CXX_COMPILER_LAUNCHER="$launcher" \
      -DNODE_ADDON_API_DIR=/src/node_modules/node-addon-api \
      -DCMAKE_JS_INC=/src/.node-headers -DCMAKE_JS_LIB= -DCMAKE_JS_SRC= \
      -DCMAKE_JS_OUTPUT_DIR="/src/$OUTPUT" \
      -DLIBASSIMP_NATIVE_BUILD_IDENTITY="linux-x64-napi${LIBASSIMP_NAPI_VERSION}" \
      -DLIBASSIMP_NATIVE_TESTS=OFF -DLIBASSIMP_NATIVE_ADDON=ON &&
      cmake --build build/native-manylinux --parallel "$(nproc)" &&
      strip --strip-unneeded "/src/$OUTPUT/libassimp.node" || status=$?
    if [ -n "$launcher" ]; then ccache --show-stats; fi
    chown -R "$HOST_OWNER" /src/build /src/.ccache /src/.node-headers "/src/$OUTPUT" /src/assimp/contrib
    exit "$status"
  '
