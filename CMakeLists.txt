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

# Which variants.json entry this build compiles. CMakePresets.json sets it along
# with the matching ASSIMP_BUILD_<FORMAT>_<SIDE> cache entries.
set(LIBASSIMP_VARIANT "full" CACHE STRING "variants.json entry to build")
option(LIBASSIMP_NATIVE_TESTS "Build the host-native ctest driver" OFF)
option(LIBASSIMP_FAST "Skip the slow optimization passes; local iteration only" OFF)

if(EMSCRIPTEN)
  if(LIBASSIMP_FAST)
    set(LIBASSIMP_OPTIMIZE "-O1")
  else()
    set(LIBASSIMP_OPTIMIZE "-O3")
  endif()
  # The engine and the binding have to agree on the exception ABI and on SIMD, so
  # these go in before assimp is configured rather than being patched on afterwards.
  # The prefix maps keep build-machine paths out of the binary: assimp, tinyusdz,
  # lib3mf and web-ifc all bake __FILE__ into assertion and log strings, which CI
  # caught as /__w/libassimp/libassimp/... inside the wasm. Both directories are
  # named because a preset may put the binary dir outside the source tree.
  set(LIBASSIMP_COMMON_FLAGS
      "${LIBASSIMP_OPTIMIZE} -DNDEBUG -fwasm-exceptions -msimd128 -ffile-prefix-map=${CMAKE_BINARY_DIR}=. -ffile-prefix-map=${CMAKE_SOURCE_DIR}=."
  )
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${LIBASSIMP_COMMON_FLAGS}")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${LIBASSIMP_COMMON_FLAGS}")
endif()

add_subdirectory(assimp)

if(EMSCRIPTEN)
  set(LIBASSIMP_TARGET "libassimp-${LIBASSIMP_VARIANT}")
  add_executable(${LIBASSIMP_TARGET} src/cpp/libassimp.cpp)
  target_link_libraries(${LIBASSIMP_TARGET} PRIVATE assimp)
  set_target_properties(${LIBASSIMP_TARGET} PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

  target_link_options(
    ${LIBASSIMP_TARGET}
    PRIVATE
    ${LIBASSIMP_OPTIMIZE}
    -fwasm-exceptions
    -msimd128
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
    -lembind
    --emit-symbol-map
    "SHELL:--emit-tsd ${LIBASSIMP_TARGET}.d.ts"
    # --converge dropped 2026-08-23: +3,287 bytes brotli-11 (+0.18%) for -261 s of an
    # importer link measured at 4,107 s on 8 cores, which is roughly -9 min on the
    # 4-vCPU CI runner. Re-measure if the runner size changes.
    "SHELL:-sBINARYEN_EXTRA_PASSES=--strip-debug,--strip-producers"
  )

  if(LIBASSIMP_FAST)
    target_link_options(${LIBASSIMP_TARGET} PRIVATE -sEVAL_CTORS=0)
  else()
    target_link_options(${LIBASSIMP_TARGET} PRIVATE --closure=1 -sEVAL_CTORS=2)
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
          obj-sidecar-via-resolve
          gltf2-to-glb
          fbx-ascii-to-glb
          collada-to-glb
          stl-to-glb
          ply-to-glb
          alias-step-writes-stp
          alias-dae-writes-dae
          no-files
          unsupported-format
          garbage-input
  )
    add_test(NAME ${case} COMMAND libassimp-native-test ${case})
  endforeach()
endif()
