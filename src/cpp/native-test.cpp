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

// Host-native ctest driver: the same libassimp::convert the wasm module calls,
// against a subset of the engine's own fixtures. Catches engine regressions
// without paying for an Emscripten link. Run with no arguments for every case,
// or with a case name for one; the exit code is the number of failures.

#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

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
    // Without lib3mf assimp's built-in 3MF exporter writes through kuba-zip straight to the real
    // filesystem, bypassing any IOSystem — so nothing reaches the file map. The wasm variants all
    // set ASSIMP_BUILD_3MF_LIB3MF=ON (where the bridge does honour the IOSystem) and the format
    // matrix covers the happy path; here we pin that the bypass surfaces as a clean failure.
    {"3mf-without-lib3mf-fails-cleanly", "OBJ/box.obj", "3mf", "EXPORT_FAILED", "", ""},
    {"obj-to-assjson", "OBJ/box.obj", "assjson", "", "{", "result.json"},
    {"obj-sidecar-via-resolve", "OBJ/spider.obj", "glb", "", "glTF", "result.glb"},
    {"gltf2-to-glb", "glTF2/BoxTextured-glTF-Binary/BoxTextured.glb", "glb", "", "glTF", "result.glb"},
    {"fbx-ascii-to-glb", "FBX/embedded_ascii/box.FBX", "glb", "", "glTF", "result.glb"},
    {"collada-to-glb", "Collada/cube_triangulate.dae", "glb", "", "glTF", "result.glb"},
    {"stl-to-glb", "STL/triangle.stl", "glb", "", "glTF", "result.glb"},
    {"ply-to-glb", "PLY/cube.ply", "glb", "", "glTF", "result.glb"},
    // Aliases resolve to assimp ids, and the output extension comes from the exporter table.
    {"alias-step-writes-stp", "OBJ/box.obj", "step", "", "ISO-10303-21", "result.stp"},
    {"alias-dae-writes-dae", "OBJ/box.obj", "dae", "", "<?xml", "result.dae"},
    {"no-files", "", "glb", "NO_FILES", "", ""},
    {"unsupported-format", "OBJ/box.obj", "nonesuch", "UNSUPPORTED_FORMAT", "", ""},
    {"garbage-input", "@garbage", "glb", "IMPORT_FAILED", "", ""},
};

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
    return !directory.empty() && readFile(directory + libassimp::MemoryFiles::basename(name), out);
  };

  const libassimp::Result result = libassimp::convert(entry, std::move(files), item.format, {}, resolve);

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
  if (result.files.empty() || result.files[0].bytes.empty()) {
    std::cerr << item.name << ": no output bytes\n";
    return false;
  }
  if (item.output[0] != '\0' && result.files[0].name != item.output) {
    std::cerr << item.name << ": expected " << item.output << ", got " << result.files[0].name << "\n";
    return false;
  }
  const std::string magic(item.magic);
  const libassimp::Bytes& bytes = result.files[0].bytes;
  if (bytes.size() < magic.size() || std::memcmp(bytes.data(), magic.data(), magic.size()) != 0) {
    std::cerr << item.name << ": output does not start with '" << magic << "'\n";
    return false;
  }
  std::cout << item.name << ": ok, " << result.files.size() << " file(s), " << bytes.size() << " bytes\n";
  return true;
}

}  // namespace

int main(int argc, char** argv) {
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
