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

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" LIBASSIMP_PACKAGE_JSON)
string(JSON LIBASSIMP_PACKAGE_VERSION GET "${LIBASSIMP_PACKAGE_JSON}" version)
string(JSON LIBASSIMP_NAPI_VERSION GET "${LIBASSIMP_PACKAGE_JSON}" binary napi_versions 0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

option(LIBASSIMP_NATIVE_TESTS "Build the host-native GoogleTest suite" OFF)
option(LIBASSIMP_NATIVE_ADDON "Build the Node-API addon" OFF)
option(LIBASSIMP_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(LIBASSIMP_CPP_COVERAGE "Instrument first-party C++ for LLVM source coverage" OFF)
option(LIBASSIMP_FAST "Skip the slow optimization passes; local iteration only" OFF)

if(NOT EMSCRIPTEN)
  # WebAssembly has no fused multiply-add instruction. Match its IEEE operation
  # boundaries so native normalisation produces byte-identical float32 output.
  if(MSVC)
    add_compile_options(/fp:strict)
  else()
    add_compile_options(-ffp-contract=off)
  endif()
endif()

if(LIBASSIMP_SANITIZERS)
  if(MSVC)
    add_compile_options(/fsanitize=address)
    add_link_options(/fsanitize=address)
  else()
    add_compile_options(-fno-omit-frame-pointer -fsanitize=address,undefined)
    add_link_options(-fno-omit-frame-pointer -fsanitize=address,undefined)
  endif()
endif()

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

if(EMSCRIPTEN OR LIBASSIMP_NATIVE_TESTS OR LIBASSIMP_NATIVE_ADDON)
  # Public glb/gltf are glTF 2 only. These are compile definitions (not CMake
  # cache switches) in Assimp and must exist before its targets are created.
  add_compile_definitions(ASSIMP_BUILD_NO_GLTF1_IMPORTER ASSIMP_BUILD_NO_GLTF1_EXPORTER)
endif()

add_subdirectory(assimp)

if(EMSCRIPTEN OR LIBASSIMP_NATIVE_TESTS OR LIBASSIMP_NATIVE_ADDON)
  # Assimp's GLTF CMake group combines v1 and v2 sources. The v1 headers honour
  # ASSIMP_BUILD_NO_GLTF1_*, but the pinned v1 exporter .cpp only checks the
  # broad GLTF guard and otherwise fails after its declarations are removed.
  # Remove only the v1 sources at this outer boundary; glTFCommon and glTF2 stay.
  get_target_property(LIBASSIMP_ASSIMP_SOURCES assimp SOURCES)
  list(FILTER LIBASSIMP_ASSIMP_SOURCES EXCLUDE REGEX "AssetLib/glTF/glTF(Asset|AssetWriter|Importer|Exporter)\\.(h|inl|cpp)$")
  set_property(TARGET assimp PROPERTY SOURCES ${LIBASSIMP_ASSIMP_SOURCES})
endif()

function(libassimp_enable_coverage target)
  if(LIBASSIMP_CPP_COVERAGE)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
      message(FATAL_ERROR "LIBASSIMP_CPP_COVERAGE requires Clang")
    endif()
    target_compile_options(${target} PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(${target} PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_compile_definitions(${target} PRIVATE LIBASSIMP_CPP_COVERAGE=1)
  endif()
endfunction()

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
endif()

if(NOT EMSCRIPTEN AND (LIBASSIMP_NATIVE_TESTS OR LIBASSIMP_NATIVE_ADDON))
  add_library(libassimp-core STATIC src/cpp/libassimp.cpp)
  target_link_libraries(libassimp-core PUBLIC assimp)
  target_include_directories(libassimp-core PUBLIC src/cpp)
  set_target_properties(
    libassimp-core
    PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES
  )
  libassimp_enable_coverage(libassimp-core)
endif()

if(LIBASSIMP_NATIVE_TESTS)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  set(gtest_force_shared_crt OFF CACHE BOOL "" FORCE)
  set(GOOGLETEST_VERSION 1.14.0)
  add_subdirectory(
    assimp/contrib/googletest/googletest
    "${CMAKE_CURRENT_BINARY_DIR}/googletest"
    EXCLUDE_FROM_ALL
  )

  add_executable(libassimp-native-test src/cpp/native-test.cpp)
  target_link_libraries(libassimp-native-test PRIVATE libassimp-core gtest_main)
  target_include_directories(libassimp-native-test PRIVATE src/cpp)
  target_compile_definitions(
    libassimp-native-test PRIVATE "LIBASSIMP_MODELS_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/assimp/test/models\""
  )

  libassimp_enable_coverage(libassimp-native-test)
  enable_testing()
  include(GoogleTest)
  gtest_discover_tests(libassimp-native-test DISCOVERY_TIMEOUT 60)

endif()

if(LIBASSIMP_NATIVE_ADDON)
  if(WIN32 AND NOT MSVC)
    message(FATAL_ERROR "Windows native addons require the MSVC toolchain")
  endif()
  if(NOT NODE_ADDON_API_DIR OR NOT EXISTS "${NODE_ADDON_API_DIR}/napi.h")
    message(FATAL_ERROR "NODE_ADDON_API_DIR must name the installed node-addon-api package")
  endif()
  if(NOT CMAKE_JS_INC)
    message(FATAL_ERROR "CMAKE_JS_INC must contain the Node.js headers (cmake-js compatible)")
  endif()
  if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    separate_arguments(LIBASSIMP_STATIC_LINKER_OPTIONS NATIVE_COMMAND "${CMAKE_STATIC_LINKER_FLAGS}")
    execute_process(
      COMMAND "${CMAKE_AR}" /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${LIBASSIMP_STATIC_LINKER_OPTIONS}
      COMMAND_ERROR_IS_FATAL ANY
    )
  endif()
  if(NOT LIBASSIMP_NATIVE_BUILD_IDENTITY)
    string(TOLOWER "${CMAKE_SYSTEM_NAME}" LIBASSIMP_NODE_PLATFORM)
    if(LIBASSIMP_NODE_PLATFORM STREQUAL "windows")
      set(LIBASSIMP_NODE_PLATFORM "win32")
    endif()
    string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" LIBASSIMP_NODE_ARCH)
    if(LIBASSIMP_NODE_ARCH MATCHES "^(amd64|x86_64)$")
      set(LIBASSIMP_NODE_ARCH "x64")
    elseif(LIBASSIMP_NODE_ARCH STREQUAL "aarch64")
      set(LIBASSIMP_NODE_ARCH "arm64")
    endif()
    set(LIBASSIMP_NATIVE_BUILD_IDENTITY "${LIBASSIMP_NODE_PLATFORM}-${LIBASSIMP_NODE_ARCH}-napi${LIBASSIMP_NAPI_VERSION}")
  endif()

  add_library(libassimp-native MODULE src/cpp/node-addon.cpp ${CMAKE_JS_SRC})
  target_include_directories(libassimp-native PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
  target_link_libraries(libassimp-native PRIVATE libassimp-core ${CMAKE_JS_LIB})
  target_compile_definitions(
    libassimp-native
    PRIVATE
      NAPI_VERSION=${LIBASSIMP_NAPI_VERSION}
      NODE_ADDON_API_CPP_EXCEPTIONS
      "LIBASSIMP_NATIVE_BUILD_IDENTITY=\"${LIBASSIMP_NATIVE_BUILD_IDENTITY}\""
      "LIBASSIMP_PACKAGE_VERSION=\"${LIBASSIMP_PACKAGE_VERSION}\""
  )
  set_target_properties(
    libassimp-native
    PROPERTIES
      PREFIX ""
      SUFFIX ".node"
      OUTPUT_NAME "libassimp"
      DEBUG_POSTFIX ""
      CXX_VISIBILITY_PRESET hidden
      VISIBILITY_INLINES_HIDDEN YES
  )
  if(CMAKE_JS_OUTPUT_DIR)
    set_target_properties(
      libassimp-native
      PROPERTIES LIBRARY_OUTPUT_DIRECTORY "${CMAKE_JS_OUTPUT_DIR}"
                 RUNTIME_OUTPUT_DIRECTORY "${CMAKE_JS_OUTPUT_DIR}"
    )
  endif()
  if(APPLE)
    target_link_options(
      libassimp-native PRIVATE "LINKER:-undefined,dynamic_lookup" "LINKER:-exported_symbol,_napi_register_module_v1"
    )
  elseif(WIN32)
    target_sources(libassimp-native PRIVATE cmake/libassimp-node.def)
  else()
    target_link_options(
      libassimp-native
      PRIVATE
        "LINKER:--exclude-libs,ALL"
        "LINKER:--version-script=${CMAKE_CURRENT_SOURCE_DIR}/cmake/libassimp-node.map"
    )
  endif()
  libassimp_enable_coverage(libassimp-native)
endif()

if(LIBASSIMP_NATIVE_TESTS AND LIBASSIMP_CPP_COVERAGE)
  set(LIBASSIMP_COVERAGE_ENV
      "LIBASSIMP_TEST_BINARY=$<TARGET_FILE:libassimp-native-test>"
      "LIBASSIMP_COVERAGE_DIR=${CMAKE_CURRENT_BINARY_DIR}/coverage"
  )
  set(LIBASSIMP_COVERAGE_DEPENDS libassimp-native-test)
  if(LIBASSIMP_NATIVE_ADDON)
    list(APPEND LIBASSIMP_COVERAGE_ENV "LIBASSIMP_NATIVE_ADDON=$<TARGET_FILE:libassimp-native>")
    list(APPEND LIBASSIMP_COVERAGE_DEPENDS libassimp-native)
  endif()
  add_custom_target(
    cpp-coverage
    COMMAND
      "${CMAKE_COMMAND}" -E env ${LIBASSIMP_COVERAGE_ENV} node
      "${CMAKE_CURRENT_SOURCE_DIR}/scripts/check-cpp-coverage.mjs"
    DEPENDS ${LIBASSIMP_COVERAGE_DEPENDS}
    USES_TERMINAL
  )
endif()
