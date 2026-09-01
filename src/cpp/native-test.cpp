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

// Host-native ctest driver: the same libassimp::Plan the wasm module calls,
// against a subset of the engine's own fixtures. Catches engine regressions
// without paying for an Emscripten link. Run with no arguments for every case,
// or with a case name for one; the exit code is the number of failures.

#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include <assimp/postprocess.h>

#include "libassimp.hpp"

namespace {

struct Case {
  const char* name;
  const char* file;    // relative to the engine's test/models, empty for the no-input case
  const char* format;
  const char* code;    // expected failure code, empty when the case must succeed
  const char* magic;   // expected first bytes of the primary output
  const char* output;  // expected primary output name, empty to skip the check
};

const Case kCases[] = {
    {"obj-to-glb", "OBJ/box.obj", "glb", "", "glTF", "result.glb"},
    {"obj-to-obj", "OBJ/box.obj", "obj", "", "#", "result.obj"},
    {"obj-to-stl", "OBJ/box.obj", "stl", "", "solid", "result.stl"},
    {"obj-to-ply", "OBJ/box.obj", "ply", "", "ply", "result.ply"},
    {"gltf2-manifold-to-3mf", "glTF2/EXT_mesh_manifold/TwoMaterialBox.glb", "3mf", "", "PK",
     "result.3mf"},
    {"obj-to-assjson", "OBJ/box.obj", "assjson", "", "{", "result.json"},
    {"obj-to-usda", "OBJ/box.obj", "usda", "", "#usda", "result.usda"},
    {"obj-to-usdz", "OBJ/box.obj", "usdz", "", "PK", "result.usdz"},
    {"obj-sidecar-via-resolve", "OBJ/spider.obj", "glb", "", "glTF", "result.glb"},
    {"gltf2-to-glb", "glTF2/BoxTextured-glTF-Binary/BoxTextured.glb", "glb", "", "glTF", "result.glb"},
    {"fbx-ascii-to-glb", "FBX/embedded_ascii/box.FBX", "glb", "", "glTF", "result.glb"},
    {"collada-to-glb", "Collada/cube_triangulate.dae", "glb", "", "glTF", "result.glb"},
    {"stl-to-glb", "STL/triangle.stl", "glb", "", "glTF", "result.glb"},
    {"ply-to-glb", "PLY/cube.ply", "glb", "", "glTF", "result.glb"},
    {"ply-pointcloud-to-glb", "PLY/points.ply", "glb", "", "glTF", "result.glb"},
    // Aliases resolve to assimp ids, and the output extension comes from the exporter table.
    {"alias-step-writes-stp", "OBJ/box.obj", "step", "", "ISO-10303-21", "result.stp"},
    {"alias-dae-writes-dae", "OBJ/box.obj", "dae", "", "<?xml", "result.dae"},
    {"no-files", "", "glb", "NO_FILES", "", ""},
    {"unsupported-format", "OBJ/box.obj", "nonesuch", "UNSUPPORTED_FORMAT", "", ""},
    {"garbage-input", "@garbage", "glb", "IMPORT_FAILED", "", ""},
    {"gltf1-rejected", "glTF/BoxTextured-glTF-Binary/BoxTextured.glb", "glb", "IMPORT_FAILED", "", ""},
};

constexpr unsigned int kPostProcess = aiProcess_Triangulate | aiProcess_GenUVCoords |
                                      aiProcess_JoinIdenticalVertices | aiProcess_SortByPType;

std::string nativeId(const std::string& format) {
  if (format == "glb") return "glb2";
  if (format == "gltf") return "gltf2";
  if (format == "step") return "stp";
  if (format == "dae") return "collada";
  return format;
}

std::string modelsDir() { return LIBASSIMP_MODELS_DIR; }

bool readFile(const std::string& path, libassimp::Bytes& out) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) return false;
  out.assign(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
  return true;
}

bool run(const Case& item) {
  std::vector<libassimp::NamedBytes> files;
  std::string entry;
  std::string directory;

  if (std::strcmp(item.file, "@garbage") == 0) {
    entry = "garbage.obj";
    files.push_back({entry, libassimp::Bytes{0x00, 0x01, 0x02, 0xff, 0xfe}});
  } else if (item.file[0] != '\0') {
    const std::string path = modelsDir() + "/" + item.file;
    entry = libassimp::MemoryFiles::basename(path);
    directory = path.substr(0, path.size() - entry.size());
    libassimp::Bytes bytes;
    if (!readFile(path, bytes)) {
      std::cerr << item.name << ": missing fixture " << path << "\n";
      return false;
    }
    files.push_back({entry, std::move(bytes)});
  }

  // Sidecars (spider.mtl, glTF .bin) are deliberately not preloaded: this is the resolve path.
  const libassimp::Resolver resolve = [&directory](const std::string& name, libassimp::Bytes& out) {
    return !directory.empty() && readFile(directory + libassimp::MemoryFiles::basename(name), out)
               ? libassimp::ResolveStatus::Found
               : libassimp::ResolveStatus::Missing;
  };

  libassimp::Plan plan(entry, std::move(files), {}, kPostProcess,
                       {{item.format, nativeId(item.format), {}}}, resolve);
  const libassimp::PlanStatus status = plan.run();
  const libassimp::Result& result = plan.result();
  if (status == libassimp::PlanStatus::Pending) {
    std::cerr << item.name << ": native resolver unexpectedly pending\n";
    return false;
  }

  if (item.code[0] != '\0') {
    if (result.ok || result.code != item.code) {
      std::cerr << item.name << ": expected " << item.code << ", got ok=" << result.ok << " code='"
                << result.code << "' message='" << result.message << "'\n";
      return false;
    }
    if (result.message.empty()) {
      std::cerr << item.name << ": failure carried no message\n";
      return false;
    }
    return true;
  }

  if (!result.ok) {
    std::cerr << item.name << ": " << result.code << ": " << result.message << "\n";
    return false;
  }
  if (result.formats.empty() || result.formats[0].files.empty() || result.formats[0].files[0].bytes.empty()) {
    std::cerr << item.name << ": no output bytes\n";
    return false;
  }
  const std::vector<libassimp::NamedBytes>& outputs = result.formats[0].files;
  if (item.output[0] != '\0' && outputs[0].name != item.output) {
    std::cerr << item.name << ": expected " << item.output << ", got " << outputs[0].name << "\n";
    return false;
  }
  const std::string magic(item.magic);
  const libassimp::Bytes& bytes = outputs[0].bytes;
  if (bytes.size() < magic.size() || std::memcmp(bytes.data(), magic.data(), magic.size()) != 0) {
    std::cerr << item.name << ": output does not start with '" << magic << "'\n";
    return false;
  }
  std::cout << item.name << ": ok, " << outputs.size() << " file(s), " << bytes.size() << " bytes\n";
  return true;
}

bool runPlanCase(const std::string& name) {
  libassimp::Bytes bytes;
  const std::string file = name == "later-target-atomic" ? "PLY/points.ply" : "OBJ/box.obj";
  const std::string path = modelsDir() + "/" + file;
  if (!readFile(path, bytes)) return false;
  std::vector<libassimp::NamedBytes> files{{libassimp::MemoryFiles::basename(path), std::move(bytes)}};
  std::vector<libassimp::Target> targets;
  if (name == "import-once-three-targets") {
    targets = {{"glb", "glb2", {}}, {"stl", "stl", {}}, {"ply", "ply", {}}};
  } else if (name == "repeated-stl-targets") {
    targets = {{"stl", "stl", {}}, {"stl", "stlb", {}}};
  } else if (name == "later-target-atomic") {
    targets = {{"assjson", "assjson", {}}, {"3mf", "3mf", {}}};
  } else {
    return false;
  }
  libassimp::Plan plan(libassimp::MemoryFiles::basename(path), std::move(files), {}, kPostProcess,
                       std::move(targets), {});
  const libassimp::PlanStatus status = plan.run();
  const libassimp::Result& result = plan.result();
  if (name == "later-target-atomic") {
    const bool passed = status == libassimp::PlanStatus::Failed && result.code == "EXPORT_FAILED" &&
                        result.formatIndex == 1 && result.format == "3mf" && result.formats.empty();
    if (!passed) {
      std::cerr << name << ": got status=" << static_cast<int>(status) << " code='" << result.code
                << "' formatIndex=" << result.formatIndex << " format='" << result.format
                << "' outputs=" << result.formats.size() << " message='" << result.message << "'\n";
    }
    return passed;
  }
  if (status != libassimp::PlanStatus::Completed || !result.ok || plan.importAttempts() != 1 ||
      result.formats.size() != 2 + (name == "import-once-three-targets")) {
    return false;
  }
  if (name == "repeated-stl-targets") {
    if (result.formats[0].files.empty() || result.formats[1].files.empty()) return false;
    return result.formats[0].files[0].bytes != result.formats[1].files[0].bytes;
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc > 1 && (std::strcmp(argv[1], "import-once-three-targets") == 0 ||
                   std::strcmp(argv[1], "repeated-stl-targets") == 0 ||
                   std::strcmp(argv[1], "later-target-atomic") == 0)) {
    return runPlanCase(argv[1]) ? 0 : 1;
  }
  int failures = 0;
  bool matched = false;
  for (const Case& item : kCases) {
    if (argc > 1 && std::strcmp(argv[1], item.name) != 0) continue;
    matched = true;
    if (!run(item)) ++failures;
  }
  if (!matched) {
    std::cerr << "unknown case: " << argv[1] << "\n";
    return 1;
  }
  return failures;
}
