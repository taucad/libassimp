# Copyright 2026 Richard Fontein
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

cmake_minimum_required(VERSION 3.28)
project(libassimp CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(LIBASSIMP_NATIVE_TESTS "Build the host-native ctest driver" OFF)
option(LIBASSIMP_FAST "Skip the slow optimization passes; local iteration only" OFF)

if(EMSCRIPTEN)
  if(LIBASSIMP_FAST)
    set(LIBASSIMP_COMPILE_OPTIMIZE "-O1")
    set(LIBASSIMP_LINK_OPTIMIZE "-O1")
  else()
    set(LIBASSIMP_COMPILE_OPTIMIZE "-O3")
    set(LIBASSIMP_LINK_OPTIMIZE "-O3")
  endif()
  # Match the production Replicad/OpenCascade shape: `-O3` compile and link, no LTO,
  # then standalone `wasm-opt -O4` in build-wasm.mjs. Binaryen's size-only
  # `code-folding` pass consumed 99.4% of a measured 4,348.7 s full link on web-ifc;
  # skipping it retains the speed-oriented passes and brings the same link to 37 s.
  # Baseline SIMD is universal in Tau's supported browsers; relaxed SIMD is not.
  # The engine and the binding have to agree on the exception ABI and on SIMD, so
  # these go in before assimp is configured rather than being patched on afterwards.
  # The prefix maps keep build-machine paths out of the binary: assimp, tinyusdz,
  # lib3mf and web-ifc all bake __FILE__ into assertion and log strings, which CI
  # caught as /__w/libassimp/libassimp/... inside the wasm. Both directories are
  # named because a preset may put the binary dir outside the source tree.
  set(LIBASSIMP_COMMON_FLAGS
      "${LIBASSIMP_COMPILE_OPTIMIZE} -DNDEBUG -fwasm-exceptions -msimd128 -ffile-prefix-map=${CMAKE_BINARY_DIR}=. -ffile-prefix-map=${CMAKE_SOURCE_DIR}=."
  )
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${LIBASSIMP_COMMON_FLAGS}")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${LIBASSIMP_COMMON_FLAGS}")
endif()

if(EMSCRIPTEN OR LIBASSIMP_NATIVE_TESTS)
  # Public glb/gltf are glTF 2 only. These are compile definitions (not CMake
  # cache switches) in Assimp and must exist before its targets are created.
  add_compile_definitions(ASSIMP_BUILD_NO_GLTF1_IMPORTER ASSIMP_BUILD_NO_GLTF1_EXPORTER)
endif()

add_subdirectory(assimp)

if(EMSCRIPTEN OR LIBASSIMP_NATIVE_TESTS)
  # Assimp's GLTF CMake group combines v1 and v2 sources. The v1 headers honour
  # ASSIMP_BUILD_NO_GLTF1_*, but the pinned v1 exporter .cpp only checks the
  # broad GLTF guard and otherwise fails after its declarations are removed.
  # Remove only the v1 sources at this outer boundary; glTFCommon and glTF2 stay.
  get_target_property(LIBASSIMP_ASSIMP_SOURCES assimp SOURCES)
  list(FILTER LIBASSIMP_ASSIMP_SOURCES EXCLUDE REGEX "AssetLib/glTF/glTF(Asset|AssetWriter|Importer|Exporter)\\.(h|inl|cpp)$")
  set_property(TARGET assimp PROPERTY SOURCES ${LIBASSIMP_ASSIMP_SOURCES})
endif()

if(EMSCRIPTEN)
  set(LIBASSIMP_TARGET "libassimp")
  add_executable(${LIBASSIMP_TARGET} src/cpp/libassimp.cpp)
  target_link_libraries(${LIBASSIMP_TARGET} PRIVATE assimp)
  set_target_properties(${LIBASSIMP_TARGET} PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

  target_link_options(
    ${LIBASSIMP_TARGET}
    PRIVATE
    ${LIBASSIMP_LINK_OPTIMIZE}
    -fwasm-exceptions
    -msimd128
    -sWASM_LEGACY_EXCEPTIONS=1
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=libassimp
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_HEAP=64MB
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=8MB
    -sFILESYSTEM=1 # the STEP and USD exporters go through the filesystem shim
    -sABORTING_MALLOC=1
    -sSUPPORT_LONGJMP=0
    -sEXIT_RUNTIME=0
    -sINVOKE_RUN=0
    -sWASM_BIGINT=1
    -sERROR_ON_UNDEFINED_SYMBOLS=0
    -lembind
    --no-entry
    --emit-symbol-map
    "SHELL:-sEXPORTED_FUNCTIONS=_libassimp_run_plan"
    "SHELL:-sBINARYEN_EXTRA_PASSES=--strip-debug,--strip-producers,--skip-pass=code-folding"
  )

  if(LIBASSIMP_FAST)
    target_link_options(${LIBASSIMP_TARGET} PRIVATE -sEVAL_CTORS=0)
  else()
    target_link_options(${LIBASSIMP_TARGET} PRIVATE --closure=1 -sEVAL_CTORS=2 -sMALLOC=mimalloc)
  endif()
elseif(LIBASSIMP_NATIVE_TESTS)
  add_executable(libassimp-native-test src/cpp/native-test.cpp src/cpp/libassimp.cpp)
  target_link_libraries(libassimp-native-test PRIVATE assimp)
  target_include_directories(libassimp-native-test PRIVATE src/cpp)
  target_compile_definitions(
    libassimp-native-test PRIVATE "LIBASSIMP_MODELS_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/assimp/test/models\""
  )

  enable_testing()
  # Case names must match the table in src/cpp/native-test.cpp; an unknown name exits 1.
  foreach(
    case
    IN
    ITEMS obj-to-glb
          obj-to-obj
          obj-to-stl
          obj-to-ply
          3mf-without-lib3mf-fails-cleanly
          obj-to-assjson
          obj-to-usda
          obj-to-usdz
          obj-sidecar-via-resolve
          gltf2-to-glb
          fbx-ascii-to-glb
          collada-to-glb
          stl-to-glb
          ply-to-glb
          ply-pointcloud-to-glb
          alias-step-writes-stp
          alias-dae-writes-dae
          no-files
          unsupported-format
          garbage-input
          gltf1-rejected
          import-once-three-targets
          repeated-stl-targets
          later-target-atomic
  )
    add_test(NAME ${case} COMMAND libassimp-native-test ${case})
  endforeach()
  # Engine null dereference in the glTF2 exporter on face-less scenes (upstream issue filing
  # pending operator approval): SIGSEGV natively, corrupt `"buffers":[]` GLB on wasm; enable at
  # the engine bump that carries the fix.
  set_tests_properties(ply-pointcloud-to-glb PROPERTIES DISABLED TRUE)
endif()
