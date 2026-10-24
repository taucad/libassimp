// Copyright 2026 Richard Fontein
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
#include <future>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <assimp/postprocess.h>
#include <assimp/cexport.h>
#include <assimp/importerdesc.h>
#include <assimp/DefaultLogger.hpp>
#include <assimp/Logger.hpp>
#include <gtest/gtest.h>

#ifdef __linux__
#include <sys/resource.h>
#include <unistd.h>
#endif

#include "libassimp.hpp"

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define LIBASSIMP_HAS_ASAN 1
#endif
#endif
#ifndef LIBASSIMP_HAS_ASAN
#define LIBASSIMP_HAS_ASAN 0
#endif

namespace {

struct ConversionCase {
  const char *name;
  const char *file;
  const char *format;
  const char *code;
  const char *magic;
  const char *output;
};

constexpr ConversionCase kCases[] = {
    {"obj_to_glb", "OBJ/box.obj", "glb", "", "glTF", "result.glb"},
    {"obj_to_obj", "OBJ/box.obj", "obj", "", "#", "result.obj"},
    {"obj_to_stl", "OBJ/box.obj", "stl", "", "solid", "result.stl"},
    {"obj_to_ply", "OBJ/box.obj", "ply", "", "ply", "result.ply"},
    {"gltf2_manifold_to_3mf", "glTF2/EXT_mesh_manifold/TwoMaterialBox.glb",
     "3mf", "", "PK", "result.3mf"},
    {"obj_to_assjson", "OBJ/box.obj", "assjson", "", "{", "result.json"},
    {"obj_to_usda", "OBJ/box.obj", "usda", "", "#usda", "result.usda"},
    {"obj_to_usdc", "OBJ/box.obj", "usdc", "", "PXR-USDC", "result.usdc"},
    {"obj_to_usdz", "OBJ/box.obj", "usdz", "", "PK", "result.usdz"},
    {"obj_sidecar_via_resolve", "OBJ/spider.obj", "glb", "", "glTF",
     "result.glb"},
    {"gltf2_to_glb", "glTF2/BoxTextured-glTF-Binary/BoxTextured.glb", "glb", "",
     "glTF", "result.glb"},
    {"fbx_ascii_to_glb", "FBX/embedded_ascii/box.FBX", "glb", "", "glTF",
     "result.glb"},
    {"collada_to_glb", "Collada/cube_triangulate.dae", "glb", "", "glTF",
     "result.glb"},
    {"stl_to_glb", "STL/triangle.stl", "glb", "", "glTF", "result.glb"},
    {"stl_binary_to_glb", "STL/Spider_binary.stl", "glb", "", "glTF",
     "result.glb"},
    {"ply_to_glb", "PLY/cube.ply", "glb", "", "glTF", "result.glb"},
    {"ply_pointcloud_to_glb", "PLY/points.ply", "glb", "", "glTF",
     "result.glb"},
    {"alias_step_writes_stp", "OBJ/box.obj", "step", "", "ISO-10303-21",
     "result.stp"},
    {"alias_dae_writes_dae", "OBJ/box.obj", "dae", "", "<?xml", "result.dae"},
    {"no_files", "", "glb", "NO_FILES", "", ""},
    {"unsupported_format", "OBJ/box.obj", "nonesuch", "UNSUPPORTED_FORMAT", "",
     ""},
    {"garbage_input", "@garbage", "glb", "IMPORT_FAILED", "", ""},
    {"gltf1_rejected", "glTF/BoxTextured-glTF-Binary/BoxTextured.glb", "glb",
     "IMPORT_FAILED", "", ""},
};

constexpr unsigned int kPostProcess =
    aiProcess_Triangulate | aiProcess_GenUVCoords |
    aiProcess_JoinIdenticalVertices | aiProcess_SortByPType;

std::string modelsDir() { return LIBASSIMP_MODELS_DIR; }

bool readFile(const std::string &path, libassimp::Bytes &out) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream)
    return false;
  out.assign(std::istreambuf_iterator<char>(stream),
             std::istreambuf_iterator<char>());
  return true;
}

std::string nativeId(const std::string &format) {
  if (format == "glb")
    return "glb2";
  if (format == "gltf")
    return "gltf2";
  if (format == "step")
    return "stp";
  if (format == "dae")
    return "collada";
  return format;
}

struct Input {
  std::string entry;
  std::string directory;
  std::vector<libassimp::NamedBytes> files;
};

Input loadInput(const char *file) {
  Input input;
  if (std::strcmp(file, "@garbage") == 0) {
    input.entry = "garbage.obj";
    input.files.push_back({input.entry, {0x00, 0x01, 0x02, 0xff, 0xfe}});
    return input;
  }
  if (file[0] == '\0')
    return input;
  const std::string path = modelsDir() + "/" + file;
  input.entry = libassimp::MemoryFiles::basename(path);
  input.directory = path.substr(0, path.size() - input.entry.size());
  libassimp::Bytes bytes;
  if (!readFile(path, bytes))
    throw std::runtime_error("missing fixture " + path);
  input.files.push_back({input.entry, std::move(bytes)});
  return input;
}

libassimp::Resolver fileResolver(const std::string &directory) {
  return [directory](const std::string &name, libassimp::Bytes &out) {
    return !directory.empty() &&
                   readFile(directory + libassimp::MemoryFiles::basename(name),
                            out)
               ? libassimp::ResolveStatus::Found
               : libassimp::ResolveStatus::Missing;
  };
}

class ConversionTest : public testing::TestWithParam<ConversionCase> {};

TEST_P(ConversionTest, Converts) {
  const ConversionCase &item = GetParam();
  Input input = loadInput(item.file);
  libassimp::Plan plan(input.entry, std::move(input.files), {}, kPostProcess,
                       {{item.format, nativeId(item.format), {}}},
                       fileResolver(input.directory));

  const libassimp::PlanStatus status = plan.run();
  const libassimp::Result &result = plan.result();
  ASSERT_NE(status, libassimp::PlanStatus::Pending);
  if (item.code[0] != '\0') {
    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.code, item.code);
    EXPECT_FALSE(result.message.empty());
    return;
  }

  ASSERT_EQ(status, libassimp::PlanStatus::Completed)
      << result.code << ": " << result.message;
  ASSERT_TRUE(result.ok);
  ASSERT_EQ(result.formats.size(), 1u);
  ASSERT_FALSE(result.formats[0].files.empty());
  const libassimp::NamedBytes &output = result.formats[0].files[0];
  EXPECT_EQ(output.name, item.output);
  ASSERT_GE(output.bytes.size(), std::strlen(item.magic));
  EXPECT_EQ(
      std::memcmp(output.bytes.data(), item.magic, std::strlen(item.magic)), 0);
}

INSTANTIATE_TEST_SUITE_P(
    Formats, ConversionTest, testing::ValuesIn(kCases),
    [](const testing::TestParamInfo<ConversionCase> &info) {
      return info.param.name;
    });

libassimp::Plan makePlan(const std::string &file,
                         std::vector<libassimp::Target> targets) {
  Input input = loadInput(file.c_str());
  return libassimp::Plan(input.entry, std::move(input.files), {}, kPostProcess,
                         std::move(targets), {});
}

libassimp::Bytes textBytes(const std::string &text) {
  return {text.begin(), text.end()};
}

TEST(PlanTest, ImportsOnceForOrderedTargets) {
  libassimp::Plan plan =
      makePlan("OBJ/box.obj",
               {{"glb", "glb2", {}}, {"stl", "stl", {}}, {"ply", "ply", {}}});
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().message;
  EXPECT_TRUE(plan.result().ok);
  EXPECT_EQ(plan.importAttempts(), 1u);
  EXPECT_EQ(plan.result().formats.size(), 3u);
}

TEST(PlanTest, ReturnsThePrimaryOutputFirstAndEachSidecarOnce) {
  libassimp::Plan plan = makePlan("glTF2/BoxTextured-glTF-Binary/BoxTextured.glb",
                                  {{"usda", "usda", {}}});
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().message;
  const auto &files = plan.result().formats.at(0).files;
  ASSERT_EQ(files.size(), 2u);
  EXPECT_EQ(files[0].name, "result.usda");
  EXPECT_EQ(files[1].name, "result_texture0.png");
  for (const libassimp::NamedBytes &file : files)
    EXPECT_FALSE(file.bytes.empty()) << file.name;
}

TEST(PlanTest, KeepsRepeatedTargetResultsSeparate) {
  libassimp::Plan plan =
      makePlan("OBJ/box.obj", {{"stl", "stl", {}}, {"stl", "stlb", {}}});
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().message;
  ASSERT_EQ(plan.result().formats.size(), 2u);
  ASSERT_FALSE(plan.result().formats[0].files.empty());
  ASSERT_FALSE(plan.result().formats[1].files.empty());
  EXPECT_NE(plan.result().formats[0].files[0].bytes,
            plan.result().formats[1].files[0].bytes);
}

TEST(PlanTest, ResolvesMultipleSidecarsInOneImport) {
  const std::string source =
      "mtllib first.mtl\nmtllib second.mtl\no triangle\nv 0 0 0\nv 1 0 0\n"
      "v 0 1 0\nusemtl first\nf 1 2 3\n";
  std::vector<std::string> requests;
  libassimp::Plan plan(
      "multiple.obj", {{"multiple.obj", textBytes(source)}}, {}, kPostProcess,
      {{"glb", "glb2", {}}},
      [&](const std::string &name, libassimp::Bytes &out) {
        requests.push_back(name);
        out = textBytes("newmtl first\nKd 1 0 0\n");
        return libassimp::ResolveStatus::Found;
      });

  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().message;
  EXPECT_EQ(plan.importAttempts(), 1u);
  EXPECT_EQ(requests,
            (std::vector<std::string>{"first.mtl", "second.mtl"}));
}

TEST(PlanTest, OmittedResolverMatchesAnExplicitMissingAnswer) {
  const std::string source =
      "mtllib missing.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  libassimp::Plan omitted(
      "optional.obj", {{"optional.obj", textBytes(source)}}, {}, kPostProcess,
      {{"glb", "glb2", {}}}, {});
  libassimp::Plan missing(
      "optional.obj", {{"optional.obj", textBytes(source)}}, {}, kPostProcess,
      {{"glb", "glb2", {}}},
      [](const std::string &, libassimp::Bytes &) { return libassimp::ResolveStatus::Missing; });
  ASSERT_EQ(omitted.run(), libassimp::PlanStatus::Completed) << omitted.result().message;
  ASSERT_EQ(missing.run(), libassimp::PlanStatus::Completed) << missing.result().message;
  EXPECT_EQ(omitted.result().formats[0].files[0].bytes, missing.result().formats[0].files[0].bytes);
  EXPECT_EQ(omitted.importAttempts(), 1u);
}

TEST(PlanTest, PublishesNoPartialResultWhenALaterTargetFails) {
  libassimp::Plan plan = makePlan(
      "PLY/points.ply", {{"assjson", "assjson", {}}, {"3mf", "3mf", {}}});
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Failed);
  EXPECT_FALSE(plan.result().ok);
  EXPECT_EQ(plan.result().formatIndex, 1);
  EXPECT_EQ(plan.result().format, "3mf");
  EXPECT_TRUE(plan.result().formats.empty());
}

TEST(PlanTest, ReplaysAfterPendingSidecarIsSupplied) {
  Input input = loadInput("OBJ/spider.obj");
  bool supplied = false;
  std::string pendingName;
  const std::string directory = input.directory;
  libassimp::Plan plan(
      input.entry, std::move(input.files), {}, kPostProcess,
      {{"glb", "glb2", {}}},
      [&](const std::string &name, libassimp::Bytes &out) {
        pendingName = name;
        if (!supplied)
          return libassimp::ResolveStatus::Pending;
        return readFile(directory + libassimp::MemoryFiles::basename(name), out)
                   ? libassimp::ResolveStatus::Found
                   : libassimp::ResolveStatus::Missing;
      });

  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
  EXPECT_EQ(plan.importAttempts(), 1u);
  EXPECT_FALSE(pendingName.empty());
  supplied = true;
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().message;
  EXPECT_EQ(plan.importAttempts(), 2u);
}

TEST(PlanTest, KeepsPendingReplayAndCachesMissingSupply) {
  Input input = loadInput("OBJ/spider.obj");
  int calls = 0;
  libassimp::Plan plan(input.entry, std::move(input.files), {}, kPostProcess,
                       {{"glb", "glb2", {}}},
                       [&](const std::string &, libassimp::Bytes &) {
                         return ++calls < 3 ? libassimp::ResolveStatus::Pending
                                            : libassimp::ResolveStatus::Missing;
                       });
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Completed);
  EXPECT_TRUE(plan.result().ok);
  EXPECT_EQ(plan.importAttempts(), 2u);
}

TEST(PlanTest, PendingReplayPreservesTerminalStates) {
  for (const libassimp::ResolveStatus terminal : {
           libassimp::ResolveStatus::Failed,
           libassimp::ResolveStatus::Aborted,
       }) {
    Input input = loadInput("OBJ/spider.obj");
    int calls = 0;
    libassimp::Plan plan(
        input.entry, std::move(input.files), {}, kPostProcess,
        {{"glb", "glb2", {}}},
        [&](const std::string &, libassimp::Bytes &) {
          return ++calls == 1 ? libassimp::ResolveStatus::Pending : terminal;
        });
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
    EXPECT_EQ(plan.run(), terminal == libassimp::ResolveStatus::Failed
                              ? libassimp::PlanStatus::Failed
                              : libassimp::PlanStatus::Aborted)
        << plan.result().code << ": " << plan.result().message;
  }
}

TEST(PlanTest, CatchesPendingReplayExceptions) {
  for (const bool standard : {true, false}) {
    Input input = loadInput("OBJ/spider.obj");
    int calls = 0;
    libassimp::Plan plan(
        input.entry, std::move(input.files), {}, kPostProcess,
        {{"glb", "glb2", {}}},
        [&](const std::string &, libassimp::Bytes &) -> libassimp::ResolveStatus {
          if (++calls == 1)
            return libassimp::ResolveStatus::Pending;
          if (standard)
            throw std::runtime_error("resolver failed");
          throw 1;
        });
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Failed);
  }
}

TEST(PlanTest, CancellationWinsOverPendingReplayExceptions) {
  for (const bool standard : {true, false}) {
    Input input = loadInput("OBJ/spider.obj");
    int calls = 0;
    libassimp::Plan *current = nullptr;
    libassimp::Plan plan(
        input.entry, std::move(input.files), {}, kPostProcess,
        {{"glb", "glb2", {}}},
        [&](const std::string &,
            libassimp::Bytes &) -> libassimp::ResolveStatus {
          if (++calls == 1)
            return libassimp::ResolveStatus::Pending;
          current->cancel();
          if (standard)
            throw std::runtime_error("cancelled resolver");
          throw 1;
        });
    current = &plan;
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Aborted)
        << plan.result().code << ": " << plan.result().message;
  }
}

TEST(PlanTest, CancellationWinsOverPendingReplayResolution) {
  Input input = loadInput("OBJ/spider.obj");
  int calls = 0;
  libassimp::Plan *current = nullptr;
  libassimp::Plan plan(
      input.entry, std::move(input.files), {}, kPostProcess,
      {{"glb", "glb2", {}}},
      [&](const std::string &, libassimp::Bytes &) {
        if (++calls == 1)
          return libassimp::ResolveStatus::Pending;
        current->cancel();
        return libassimp::ResolveStatus::Missing;
      });
  current = &plan;
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Aborted);
}

TEST(PlanTest, ResolverTerminalStateWinsOverSwallowedIoErrors) {
  const std::string source =
      "mtllib sidecar.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  const auto check = [&](libassimp::ResolveStatus resolveStatus,
                         libassimp::PlanStatus planStatus) {
    libassimp::Plan plan(
        "terminal.obj", {{"terminal.obj", textBytes(source)}}, {},
        kPostProcess, {{"glb", "glb2", {}}},
        [resolveStatus](const std::string &, libassimp::Bytes &) {
          return resolveStatus;
        });
    EXPECT_EQ(plan.run(), planStatus);
    EXPECT_FALSE(plan.result().ok);
    EXPECT_EQ(plan.importAttempts(), 1u);
  };
  check(libassimp::ResolveStatus::Failed, libassimp::PlanStatus::Failed);
  check(libassimp::ResolveStatus::Aborted, libassimp::PlanStatus::Aborted);
}

TEST(PlanTest, TurnsResolverExceptionsIntoFailures) {
  for (const bool standard : {true, false}) {
    Input input = loadInput("OBJ/spider.obj");
    libassimp::Plan plan(input.entry, std::move(input.files), {}, kPostProcess,
                         {{"glb", "glb2", {}}},
                         [&](const std::string &,
                             libassimp::Bytes &) -> libassimp::ResolveStatus {
                           if (standard)
                             throw std::runtime_error("resolver failed");
                           throw 1;
                         });
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Failed);
    EXPECT_EQ(plan.result().code, "RESOLVE_FAILED");
    EXPECT_EQ(plan.importAttempts(), 1u);
  }
}

TEST(PlanTest, CancelsBeforeImport) {
  libassimp::Plan plan = makePlan("OBJ/box.obj", {{"glb", "glb2", {}}});
  plan.cancel();
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Aborted);
  EXPECT_EQ(plan.importAttempts(), 0u);
}

#ifdef LIBASSIMP_CPP_COVERAGE
void expectCancellationAtPhase(libassimp::ProgressPhase phase) {
  libassimp::Plan plan = makePlan("OBJ/box.obj", {{"glb", "glb2", {}}});
  libassimp::detail::blockNextProgress(phase);
  std::future<libassimp::PlanStatus> running =
      std::async(std::launch::async, [&] { return plan.run(); });
  for (int attempt = 0;
       attempt < 1000 && libassimp::detail::progressBlocked() != phase;
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  EXPECT_EQ(libassimp::detail::progressBlocked(), phase);
  plan.cancel();
  EXPECT_EQ(running.get(), libassimp::PlanStatus::Aborted);
  EXPECT_EQ(plan.importAttempts(), 1u);
  EXPECT_TRUE(plan.result().formats.empty());
  EXPECT_EQ(libassimp::detail::progressBlocked(),
            libassimp::ProgressPhase::None);
  libassimp::detail::releaseProgress();
}

TEST(PlanTest, CancelsWhileImporting) {
  expectCancellationAtPhase(libassimp::ProgressPhase::Importing);
}

TEST(PlanTest, CancelsWhilePostProcessing) {
  expectCancellationAtPhase(libassimp::ProgressPhase::PostProcessing);
}

TEST(PlanTest, CancelsWhileExporting) {
  expectCancellationAtPhase(libassimp::ProgressPhase::Exporting);
}

TEST(PlanTest, ContinuesAfterAProgressCheckpointIsReleased) {
  libassimp::Plan plan = makePlan("OBJ/box.obj", {{"glb", "glb2", {}}});
  libassimp::detail::blockNextProgress(libassimp::ProgressPhase::Importing);
  std::future<libassimp::PlanStatus> running =
      std::async(std::launch::async, [&] { return plan.run(); });
  for (int attempt = 0;
       attempt < 1000 && libassimp::detail::progressBlocked() !=
                               libassimp::ProgressPhase::Importing;
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  EXPECT_EQ(libassimp::detail::progressBlocked(),
            libassimp::ProgressPhase::Importing);
  libassimp::detail::releaseProgress();
  EXPECT_EQ(running.get(), libassimp::PlanStatus::Completed);
  EXPECT_EQ(libassimp::detail::progressBlocked(),
            libassimp::ProgressPhase::None);
  EXPECT_EQ(plan.phaseDiagnostics().observed,
            (std::array<bool, 3>{true, true, true}));
}

TEST(PlanTest, HandlesResolverStateDuringExport) {
  for (const libassimp::ResolveStatus terminal : {
           libassimp::ResolveStatus::Failed,
           libassimp::ResolveStatus::Aborted,
       }) {
    Input input = loadInput("OBJ/box.obj");
    libassimp::Plan plan(
        input.entry, std::move(input.files), {}, kPostProcess,
        {{"probe", "__test_probe", {}}},
        [terminal](const std::string &, libassimp::Bytes &) {
          return terminal;
        });
    EXPECT_EQ(plan.run(), terminal == libassimp::ResolveStatus::Failed
                              ? libassimp::PlanStatus::Failed
                              : libassimp::PlanStatus::Aborted)
        << plan.result().code << ": " << plan.result().message;
  }

  for (const libassimp::ResolveStatus terminal : {
           libassimp::ResolveStatus::Failed,
           libassimp::ResolveStatus::Aborted,
       }) {
    Input input = loadInput("OBJ/box.obj");
    int calls = 0;
    libassimp::Plan plan(
        input.entry, std::move(input.files), {}, kPostProcess,
        {{"probe", "__test_probe", {}}},
        [&](const std::string &, libassimp::Bytes &) {
          return ++calls == 1 ? libassimp::ResolveStatus::Pending : terminal;
        });
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
    EXPECT_TRUE(plan.result().formats.empty());
    EXPECT_EQ(plan.run(), terminal == libassimp::ResolveStatus::Failed
                              ? libassimp::PlanStatus::Failed
                              : libassimp::PlanStatus::Aborted)
        << plan.result().code << ": " << plan.result().message;
    EXPECT_TRUE(plan.result().formats.empty());
    EXPECT_EQ(plan.importAttempts(), 1u);
    EXPECT_EQ(calls, 2);
  }

  Input input = loadInput("OBJ/box.obj");
  libassimp::Plan *current = nullptr;
  libassimp::Plan plan(
      input.entry, std::move(input.files), {}, kPostProcess,
      {{"probe", "__test_probe", {}}},
      [&](const std::string &, libassimp::Bytes &) {
        current->cancel();
        return libassimp::ResolveStatus::Missing;
      });
  current = &plan;
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Aborted)
      << plan.result().code << ": " << plan.result().message;
}

TEST(PlanTest, ReplaysASecondExportWithFreshOutputsAfterPending) {
  Input input = loadInput("OBJ/box.obj");
  int calls = 0;
  libassimp::Plan plan(
      input.entry, std::move(input.files), {}, kPostProcess,
      {{"stl", "stl", {}}, {"probe", "__test_probe", {}}},
      [&](const std::string &name, libassimp::Bytes &out) {
        EXPECT_EQ(name, "coverage.sidecar");
        if (++calls == 1) return libassimp::ResolveStatus::Pending;
        out = {2};
        return libassimp::ResolveStatus::Found;
      });

  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
  EXPECT_TRUE(plan.result().formats.empty());
  EXPECT_EQ(plan.importAttempts(), 1u);
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().code << ": " << plan.result().message;
  EXPECT_EQ(plan.importAttempts(), 2u);
  EXPECT_EQ(calls, 2);
  ASSERT_EQ(plan.result().formats.size(), 2u);
  const std::vector<libassimp::NamedBytes> &outputs =
      plan.result().formats[1].files;
  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_EQ(outputs[0].name, "result.probe");
  EXPECT_EQ(outputs[0].bytes, (libassimp::Bytes{1}));
  EXPECT_EQ(outputs[1].name, "result.sidecar");
  EXPECT_EQ(outputs[1].bytes, (libassimp::Bytes{2}));
}
#endif

struct HostFiles {
  std::map<std::uint32_t, libassimp::Bytes> files;
  int failAt = -1;
  int calls = 0;

  libassimp::OutputSink sink() {
    return [this](std::uint32_t file, std::size_t offset, const std::uint8_t *data, std::size_t size) {
      if (calls++ == failAt)
        return false;
      libassimp::Bytes &bytes = files[file];
      if (bytes.size() < offset + size)
        bytes.resize(offset + size);
      std::memcpy(bytes.data() + offset, data, size);
      return true;
    };
  }
};

libassimp::Bytes noisyObj(int materialLibraries) {
  std::string source;
  for (int index = 0; index < materialLibraries; ++index)
    source += "mtllib\n";
  source += "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  return textBytes(source);
}

TEST(PlanTest, NamesOutputsStreamsThemAndReleasesTheEntry) {
  HostFiles host;
  libassimp::Plan plan(
      "chair.obj",
      {{"chair.obj", textBytes("mtllib chair.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl wood\nf 1 2 3\n")},
       {"chair.mtl", textBytes("newmtl wood\nKd 1 0 0\n")}},
      {}, kPostProcess, {{"obj", "obj", {}, "chair.obj"}, {"stl", "stl", {}}}, {});
  plan.setReleaseEntryAfterImport(true);
  plan.setOutputSink(host.sink());
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed) << plan.result().message;
  const auto &formats = plan.result().formats;
  ASSERT_EQ(formats.size(), 2u);
  ASSERT_EQ(formats[0].files.size(), 2u);
  EXPECT_EQ(formats[0].files[0].name, "chair.obj");
  EXPECT_EQ(formats[0].files[1].name, "chair.mtl");
  EXPECT_EQ(formats[1].files[0].name, "result.stl");
  for (const auto &format : formats) {
    for (const libassimp::NamedBytes &file : format.files) {
      EXPECT_TRUE(file.bytes.empty());
      ASSERT_NE(file.hostFile, 0u);
      EXPECT_EQ(host.files[file.hostFile].size(), file.size) << file.name;
    }
  }
  const libassimp::Bytes &mtl = host.files[formats[0].files[1].hostFile];
  EXPECT_NE(std::string(mtl.begin(), mtl.end()).find("newmtl"), std::string::npos);
  EXPECT_GE(plan.result().timings.import, 0.0);
  EXPECT_GE(plan.result().timings.postProcess, 0.0);
  EXPECT_GE(plan.result().timings.exportAll, 0.0);
}

TEST(PlanTest, ReportsProgressThrottledBetweenPhaseBoundaries) {
  struct Report {
    libassimp::ProgressPhase phase;
    int step;
    int total;
    int formatIndex;
  };
  const auto collect = [](std::chrono::milliseconds interval, unsigned int postProcess) {
    std::vector<Report> reports;
    Input input = loadInput("OBJ/box.obj");
    libassimp::Plan plan(input.entry, std::move(input.files), {}, postProcess,
                         {{"glb", "glb2", {}}, {"stl", "stl", {}}}, {});
    plan.setProgressSink(
        [&](libassimp::ProgressPhase phase, int step, int total, int formatIndex) {
          reports.push_back({phase, step, total, formatIndex});
        },
        interval);
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Completed) << plan.result().message;
    if (postProcess == 0)
      EXPECT_EQ(plan.result().timings.postProcess, 0.0);
    return reports;
  };
  const std::vector<Report> every = collect(std::chrono::milliseconds(0), kPostProcess);
  const std::vector<Report> throttled = collect(std::chrono::hours(1), kPostProcess);
  ASSERT_FALSE(every.empty());
  EXPECT_LT(throttled.size(), every.size());
  EXPECT_EQ(every.front().phase, libassimp::ProgressPhase::Importing);
  EXPECT_EQ(every.front().formatIndex, -1);
  EXPECT_TRUE(std::any_of(every.begin(), every.end(), [](const Report &report) {
    return report.phase == libassimp::ProgressPhase::PostProcessing;
  }));
  EXPECT_EQ(every.back().phase, libassimp::ProgressPhase::Exporting);
  EXPECT_EQ(every.back().formatIndex, 1);
  EXPECT_EQ(every.back().step, every.back().total);
  for (const Report &report : throttled)
    EXPECT_TRUE(report.step <= 0 || report.step >= report.total);
  const std::vector<Report> bare = collect(std::chrono::milliseconds(0), 0);
  EXPECT_FALSE(std::any_of(bare.begin(), bare.end(), [](const Report &report) {
    return report.phase == libassimp::ProgressPhase::PostProcessing;
  }));
}

TEST(PlanTest, CollectsWarningsUpToTheCapAndCountsTheRest) {
  libassimp::Plan few("few.obj", {{"few.obj", noisyObj(2)}}, {}, kPostProcess, {{"stl", "stl", {}}}, {});
  ASSERT_EQ(few.run(), libassimp::PlanStatus::Completed) << few.result().message;
  ASSERT_GE(few.result().warnings.size(), 2u);
  EXPECT_FALSE(few.result().warnings[0].error);
  EXPECT_EQ(few.result().warnings[0].phase, libassimp::ProgressPhase::Importing);
  EXPECT_EQ(few.result().warnings[0].formatIndex, -1);
  EXPECT_NE(few.result().warnings[0].message.find("material library"), std::string::npos);

  libassimp::Plan many("many.obj", {{"many.obj", noisyObj(70)}}, {}, kPostProcess, {{"stl", "stl", {}}}, {});
  ASSERT_EQ(many.run(), libassimp::PlanStatus::Completed) << many.result().message;
  const auto &warnings = many.result().warnings;
  ASSERT_EQ(warnings.size(), libassimp::kMaxWarnings + 1);
  EXPECT_NE(warnings.back().message.find("more assimp messages were omitted."), std::string::npos);

  // Outside a run the installed logger drops everything and never accepts streams.
  Assimp::Logger *logger = Assimp::DefaultLogger::get();
  EXPECT_FALSE(logger->attachStream(nullptr, 0));
  EXPECT_FALSE(logger->detachStream(nullptr, 0));
  logger->setLogSeverity(Assimp::Logger::VERBOSE);
  logger->verboseDebug("verbose");
  logger->setLogSeverity(Assimp::Logger::NORMAL);
  logger->debug("debug");
  logger->info("info");
  logger->warn("warning outside a run");
  logger->error("error outside a run");
  libassimp::Plan quiet("quiet.obj", {{"quiet.obj", noisyObj(0)}}, {}, kPostProcess, {{"stl", "stl", {}}}, {});
  ASSERT_EQ(quiet.run(), libassimp::PlanStatus::Completed) << quiet.result().message;
  for (const libassimp::Warning &warning : quiet.result().warnings)
    EXPECT_EQ(warning.message.find("outside a run"), std::string::npos);
}

#if defined(__linux__) && !defined(__SANITIZE_ADDRESS__) && !LIBASSIMP_HAS_ASAN
TEST(PlanTest, ReportsAnAllocationFailureAsLimitExceededAndRecovers) {
  // Four billion float3 vertices need 48 GB; an address-space limit makes the allocation fail
  // promptly instead of depending on the runner's overcommit policy.
  rlimit previous{};
  ASSERT_EQ(getrlimit(RLIMIT_AS, &previous), 0);
  long pages = 0;
  {
    std::ifstream statm("/proc/self/statm");
    statm >> pages;
  }
  rlimit limited = previous;
  limited.rlim_cur = static_cast<rlim_t>(pages) * static_cast<rlim_t>(sysconf(_SC_PAGESIZE)) +
                     (rlim_t(4) << 30);
  ASSERT_EQ(setrlimit(RLIMIT_AS, &limited), 0);
  libassimp::Plan plan(
      "huge.ply",
      {{"huge.ply", textBytes("ply\nformat ascii 1.0\nelement vertex 4000000000\nproperty float x\n"
                              "property float y\nproperty float z\nend_header\n0 0 0\n")}},
      {}, kPostProcess, {{"stl", "stl", {}}}, {});
  const libassimp::PlanStatus status = plan.run();
  ASSERT_EQ(setrlimit(RLIMIT_AS, &previous), 0);
  EXPECT_EQ(status, libassimp::PlanStatus::Failed);
  EXPECT_EQ(plan.result().code, "LIMIT_EXCEEDED") << plan.result().message;
  EXPECT_EQ(plan.result().formatIndex, -1);

  libassimp::Plan after = makePlan("OBJ/box.obj", {{"stl", "stl", {}}});
  EXPECT_EQ(after.run(), libassimp::PlanStatus::Completed) << after.result().message;
}
#endif

TEST(PlanTest, RejectsAnEmptyTargetList) {
  libassimp::Plan plan = makePlan("OBJ/box.obj", {});
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Failed);
  EXPECT_EQ(plan.result().code, "INVALID_OPTIONS");
}

TEST(PlanTest, AppliesEveryPropertyKindToImportAndExport) {
  const libassimp::Matrix matrix{1, 0, 0, 0, 0, 1, 0, 0,
                                 0, 0, 1, 0, 0, 0, 0, 1};
  const libassimp::Properties properties{
      {"libassimp.bool", true},
      {"libassimp.integer", 2},
      {"libassimp.number", 0.5},
      {"libassimp.string", std::string("value")},
      {"libassimp.matrix", matrix}};
  Input input = loadInput("OBJ/box.obj");
  libassimp::Plan plan(input.entry, std::move(input.files), properties,
                       kPostProcess, {{"glb", "glb2", properties}}, {});
  ASSERT_EQ(plan.run(), libassimp::PlanStatus::Completed)
      << plan.result().message;
}

#ifdef LIBASSIMP_CPP_COVERAGE
TEST(PlanTest, RejectsAnExporterThatReturnsWithoutWriting) {
  libassimp::Plan plan =
      makePlan("OBJ/box.obj", {{"empty", "__test_empty", {}}});
  EXPECT_EQ(plan.run(), libassimp::PlanStatus::Failed);
  EXPECT_EQ(plan.result().code, "EXPORT_FAILED");
  EXPECT_EQ(plan.result().message, "The exporter produced no output.");
}
#endif

TEST(MemoryIOTest, SupportsLookupOutputAndSeek) {
  std::deque<libassimp::NamedBytes> inputs{{"dir/input.bin", {1, 2, 3}}};
  libassimp::MemoryFiles files(inputs, {});
  ASSERT_NE(files.find("input.bin"), nullptr);
  EXPECT_EQ(libassimp::MemoryFiles::basename("one\\two/file.bin"), "file.bin");
  EXPECT_FALSE(files.wrote("output.bin"));
  libassimp::MemoryWriteStream stream(files.output("output.bin"));
  const std::uint8_t bytes[] = {4, 5, 6};
  EXPECT_EQ(stream.Write(bytes, 1, 3), 3u);
  EXPECT_EQ(stream.Seek(1, aiOrigin_SET), AI_SUCCESS);
  EXPECT_EQ(stream.Write(bytes, 1, 1), 1u);
  EXPECT_EQ(stream.Seek(1, aiOrigin_CUR), AI_SUCCESS);
  EXPECT_EQ(stream.Seek(1, aiOrigin_END), AI_SUCCESS);
  EXPECT_EQ(stream.Seek(99, aiOrigin_END), AI_FAILURE);
  EXPECT_EQ(stream.Read(nullptr, 0, 0), 0u);
  EXPECT_EQ(stream.Tell(), 2u);
  EXPECT_EQ(stream.FileSize(), 3u);
  EXPECT_EQ(stream.Write(nullptr, 0, 3), 3u);
  EXPECT_EQ(stream.Write(bytes, std::numeric_limits<std::size_t>::max(), 2),
            0u);
  EXPECT_EQ(stream.Write(bytes, std::numeric_limits<std::size_t>::max(), 1),
            0u);
  EXPECT_EQ(stream.Seek(std::numeric_limits<std::size_t>::max(), aiOrigin_CUR),
            AI_FAILURE);
  stream.Flush();
  EXPECT_TRUE(files.wrote("output.bin"));
  EXPECT_FALSE(files.wrote("missing.bin"));
  ASSERT_EQ(files.outputs().size(), 1u);
  EXPECT_EQ(files.outputs().front().name(), "output.bin");
  const std::vector<libassimp::NamedBytes> taken = files.takeOutputs("output.bin");
  ASSERT_EQ(taken.size(), 1u);
  EXPECT_EQ(taken[0].bytes, (libassimp::Bytes{4, 4, 6}));
  EXPECT_EQ(taken[0].size, 3u);
  EXPECT_EQ(taken[0].hostFile, 0u);
  EXPECT_TRUE(files.outputs().empty());
}

TEST(MemoryIOTest, ReturnsSidecarsWhenThePrimaryWasNeverWritten) {
  std::deque<libassimp::NamedBytes> inputs;
  libassimp::MemoryFiles files(inputs, {});
  const std::uint8_t byte = 9;
  libassimp::MemoryWriteStream(files.output("sidecar.bin")).Write(&byte, 1, 1);
  const std::vector<libassimp::NamedBytes> taken = files.takeOutputs("primary.bin");
  ASSERT_EQ(taken.size(), 1u);
  EXPECT_EQ(taken[0].name, "sidecar.bin");
  EXPECT_EQ(taken[0].bytes, (libassimp::Bytes{9}));
}

TEST(MemoryIOTest, StreamsCompleteChunksAndWritesThroughAfterTheyLeave) {
  constexpr std::size_t kChunk = libassimp::OutputFile::kChunk;
  HostFiles host;
  const libassimp::OutputSink sink = host.sink();
  std::uint32_t nextHostFile = 7;
  std::deque<libassimp::NamedBytes> inputs;
  libassimp::MemoryFiles files(inputs, {}, &sink, &nextHostFile);
  libassimp::MemoryWriteStream stream(files.output("big.bin"));
  libassimp::MemoryWriteStream(files.output("small.bin")).Write("ab", 1, 2);
  EXPECT_EQ(nextHostFile, 9u);
  const libassimp::Bytes first(kChunk + 10, 1);
  EXPECT_EQ(stream.Write(first.data(), 1, first.size()), first.size());
  EXPECT_EQ(host.files[7].size(), kChunk);
  EXPECT_EQ(stream.Seek(4, aiOrigin_SET), AI_SUCCESS);
  const std::uint8_t patch[] = {5, 6};
  EXPECT_EQ(stream.Write(patch, 1, 2), 2u);
  EXPECT_EQ(host.files[7][4], 5);
  EXPECT_EQ(stream.Seek(kChunk * 2 + 3, aiOrigin_SET), AI_SUCCESS);

  const std::vector<libassimp::NamedBytes> taken = files.takeOutputs("big.bin");
  ASSERT_EQ(taken.size(), 2u);
  EXPECT_EQ(taken[0].name, "big.bin");
  EXPECT_EQ(taken[0].hostFile, 7u);
  EXPECT_EQ(taken[0].size, kChunk * 2 + 3);
  EXPECT_TRUE(taken[0].bytes.empty());
  ASSERT_EQ(host.files[7].size(), kChunk * 2 + 3);
  EXPECT_EQ(host.files[7][5], 6);
  EXPECT_EQ(host.files[7][kChunk + 9], 1);
  EXPECT_EQ(host.files[7][kChunk + 10], 0);
  EXPECT_EQ(taken[1].hostFile, 8u);
  EXPECT_EQ(host.files[8], (libassimp::Bytes{'a', 'b'}));
}

TEST(MemoryIOTest, ReportsAHostThatCannotTakeAChunk) {
  constexpr std::size_t kChunk = libassimp::OutputFile::kChunk;
  const libassimp::Bytes data(kChunk, 3);
  for (const int failAt : {0, 1}) {
    HostFiles host;
    host.failAt = failAt;
    const libassimp::OutputSink sink = host.sink();
    std::uint32_t nextHostFile = 1;
    std::deque<libassimp::NamedBytes> inputs;
    libassimp::MemoryFiles files(inputs, {}, &sink, &nextHostFile);
    libassimp::MemoryWriteStream stream(files.output("out.bin"));
    if (failAt == 0) {
      // The chunk is complete, so handing it over fails inside Write.
      EXPECT_EQ(stream.Write(data.data(), 1, data.size()), 0u);
    } else {
      // The chunk leaves, then a write back into it cannot reach the host.
      EXPECT_EQ(stream.Write(data.data(), 1, data.size()), data.size());
      EXPECT_EQ(stream.Seek(0, aiOrigin_SET), AI_SUCCESS);
      EXPECT_EQ(stream.Write(data.data(), 1, 1), 0u);
    }
  }
  HostFiles host;
  host.failAt = 0;
  const libassimp::OutputSink sink = host.sink();
  std::uint32_t nextHostFile = 1;
  std::deque<libassimp::NamedBytes> inputs;
  libassimp::MemoryFiles files(inputs, {}, &sink, &nextHostFile);
  libassimp::MemoryWriteStream(files.output("tail.bin")).Write("x", 1, 1);
  EXPECT_THROW(files.takeOutputs("tail.bin"), std::runtime_error);
}

TEST(MemoryIOTest, ResolvesAnAmbiguousBasenameInsteadOfChoosingOne) {
  std::deque<libassimp::NamedBytes> inputs{{"red/albedo.bin", {1}},
                                           {"blue/albedo.bin", {2}}};
  int calls = 0;
  libassimp::MemoryFiles files(
      inputs, [&](const std::string &name, libassimp::Bytes &bytes) {
        ++calls;
        EXPECT_EQ(name, "other/albedo.bin");
        bytes = {3};
        return libassimp::ResolveStatus::Found;
      });
  ASSERT_NE(files.find("other/albedo.bin"), nullptr);
  EXPECT_EQ(*files.find("other/albedo.bin"), (libassimp::Bytes{3}));
  EXPECT_EQ(calls, 1);
}

TEST(MemoryIOTest, CachesResolverOutcomesAndImplementsTheIOSystem) {
  std::deque<libassimp::NamedBytes> inputs{{"dir/input.bin", {1, 2, 3}}};
  int missingCalls = 0;
  libassimp::MemoryFiles missing(inputs,
                                 [&](const std::string &, libassimp::Bytes &) {
                                   ++missingCalls;
                                   return libassimp::ResolveStatus::Missing;
                                 });
  EXPECT_EQ(missing.find("missing.bin"), nullptr);
  EXPECT_EQ(missing.find("missing.bin"), nullptr);
  EXPECT_EQ(missingCalls, 1);
  EXPECT_EQ(&missing.output("same.bin"), &missing.output("same.bin"));

  libassimp::MemoryFiles pending(inputs,
                                 [](const std::string &, libassimp::Bytes &) {
                                   return libassimp::ResolveStatus::Pending;
                                 });
  EXPECT_EQ(pending.find("later.bin"), nullptr);
  EXPECT_EQ(pending.find("another.bin"), nullptr);
  EXPECT_TRUE(pending.pending());
  EXPECT_EQ(pending.pendingName(), "later.bin");

  libassimp::MemoryFiles found(
      inputs, [](const std::string &, libassimp::Bytes &bytes) {
        bytes = {7, 8};
        return libassimp::ResolveStatus::Found;
      });
  ASSERT_NE(found.find("resolved.bin"), nullptr);
  EXPECT_EQ(*found.find("resolved.bin"), (libassimp::Bytes{7, 8}));

  libassimp::MemoryFiles ioFiles(inputs, {});
  libassimp::MemoryIO reader(ioFiles, false);
  EXPECT_TRUE(reader.Exists("input.bin"));
  EXPECT_FALSE(reader.Exists("absent.bin"));
  EXPECT_EQ(reader.getOsSeparator(), '/');
  EXPECT_TRUE(reader.ComparePaths("one/input.bin", "two\\input.bin"));
  EXPECT_EQ(reader.Open("absent.bin", "r"), nullptr);
  Assimp::IOStream *readStream = reader.Open("input.bin", "r");
  ASSERT_NE(readStream, nullptr);
  reader.Close(readStream);

  libassimp::MemoryIO writer(ioFiles, true);
  EXPECT_TRUE(writer.Exists("input.bin"));
  Assimp::IOStream *writeStream = writer.Open("append.bin", "a");
  ASSERT_NE(writeStream, nullptr);
  writer.Close(writeStream);
  Assimp::IOStream *writerReadStream = writer.Open("input.bin", "r");
  ASSERT_NE(writerReadStream, nullptr);
  writer.Close(writerReadStream);
  EXPECT_TRUE(writer.Exists("append.bin"));
}

TEST(MemoryIOTest, StopsCachedAndUnknownOpensAfterTerminalResolution) {
  for (const libassimp::ResolveStatus status : {
           libassimp::ResolveStatus::Pending,
           libassimp::ResolveStatus::Failed,
           libassimp::ResolveStatus::Aborted,
       }) {
    std::deque<libassimp::NamedBytes> inputs{{"dir/input.bin", {1, 2, 3}}};
    int calls = 0;
    libassimp::MemoryFiles files(inputs, [&](const std::string &, libassimp::Bytes &) {
      ++calls;
      return status;
    });
    EXPECT_EQ(files.find("missing.bin"), nullptr);
    EXPECT_EQ(files.find("dir/input.bin"), nullptr);
    EXPECT_EQ(files.find("input.bin"), nullptr);
    EXPECT_EQ(files.find("another.bin"), nullptr);
    EXPECT_EQ(calls, 1);
  }
}

TEST(FormatTest, ReportsCompiledFormats) {
  EXPECT_FALSE(libassimp::importFormats().empty());
  EXPECT_FALSE(libassimp::exportFormats().empty());
}

TEST(FormatTest, IgnoresDefensiveNullDescriptions) {
  std::vector<libassimp::FormatInfo> formats;
  EXPECT_FALSE(libassimp::detail::exportFormatMatches(nullptr, "glb2"));
  libassimp::detail::appendImportFormats(formats, nullptr);
  aiImporterDesc importer{};
  libassimp::detail::appendImportFormats(formats, &importer);
  libassimp::detail::appendExportFormat(formats, nullptr);
  EXPECT_TRUE(formats.empty());
}

} // namespace
