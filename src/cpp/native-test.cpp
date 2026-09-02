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
#include <cstring>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include <assimp/postprocess.h>
#include <assimp/cexport.h>
#include <assimp/importerdesc.h>
#include <gtest/gtest.h>

#include "libassimp.hpp"

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

TEST(PlanTest, TurnsResolverExceptionsIntoFailures) {
  for (const bool standard : {true, false}) {
    Input input = loadInput("OBJ/spider.obj");
    bool replay = false;
    libassimp::Plan plan(input.entry, std::move(input.files), {}, kPostProcess,
                         {{"glb", "glb2", {}}},
                         [&](const std::string &,
                             libassimp::Bytes &) -> libassimp::ResolveStatus {
                           if (!replay) {
                             replay = true;
                             return libassimp::ResolveStatus::Pending;
                           }
                           if (standard)
                             throw std::runtime_error("resolver failed");
                           throw 1;
                         });
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Pending);
    EXPECT_EQ(plan.run(), libassimp::PlanStatus::Failed);
    EXPECT_EQ(plan.result().message,
              standard ? "resolver failed" : "Unknown error.");
  }
}

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
  EXPECT_EQ(files.outputs().front().bytes, (libassimp::Bytes{4, 4, 6}));
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
