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

// libFuzzer harness over the same Plan pipeline both backends call.
//
// Input layout: an ASCII header line "<entry extension> <target>\n" followed
// by the entry file's bytes. The extension picks the importer the way a
// caller's file name does (content sniffing still runs when it refuses), and
// the target picks the exporter. An input without a recognisable header is
// fed whole to a rotating extension, so mutations that destroy the header
// still reach the importers. Seeds live in tests/fuzz/corpus and are written
// by scripts/generate-fuzz-corpus.mjs.

#include <assimp/postprocess.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "libassimp.hpp"

namespace {

constexpr const char* kExtensions[] = {
    "gltf", "glb", "obj", "fbx", "dae", "stl", "ply", "usda", "usdc", "usdz", "usd", "3mf",
    "zae",  "pk3", "bsp", "off", "ifc", "md2", "md3", "md5mesh", "mdl", "ms3d",
    "lwo",  "lws", "ac",  "ase", "b3d", "blend", "cob", "csm", "dxf", "hmp", "irr", "lxo",
    "ndo",  "nff", "ogex", "pmx", "q3o", "q3s", "sib", "smd", "ter", "xgl", "zgl", "amf",
    "mesh.xml", "3d", "vrm", "md5anim", "md5camera", "bvh", "iqm", "mot"};

struct TargetId {
  const char* format;
  const char* nativeId;
};

constexpr TargetId kTargets[] = {{"glb", "glb2"},       {"gltf", "gltf2"}, {"obj", "obj"},
                                 {"stl", "stl"},        {"ply", "ply"},    {"assjson", "assjson"},
                                 {"dae", "collada"},    {"3mf", "3mf"},    {"usda", "usda"},
                                 {"usdz", "usdz"},      {"step", "stp"},   {"fbx", "fbx"}};

constexpr unsigned int kPostProcess = aiProcess_Triangulate | aiProcess_GenUVCoords |
                                      aiProcess_JoinIdenticalVertices | aiProcess_SortByPType |
                                      aiProcess_ValidateDataStructure;

const TargetId* findTarget(const std::string& name) {
  for (const TargetId& target : kTargets) {
    if (name == target.format) return &target;
  }
  return nullptr;
}

bool knownExtension(const std::string& name) {
  for (const char* extension : kExtensions) {
    if (name == extension) return true;
  }
  return false;
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
  std::string extension;
  const TargetId* target = nullptr;
  std::size_t offset = 0;

  const std::size_t headerLimit = size < 32 ? size : 32;
  for (std::size_t index = 0; index < headerLimit; ++index) {
    if (data[index] != '\n') continue;
    const std::string header(reinterpret_cast<const char*>(data), index);
    const std::size_t space = header.find(' ');
    if (space != std::string::npos && knownExtension(header.substr(0, space))) {
      extension = header.substr(0, space);
      target = findTarget(header.substr(space + 1));
      offset = index + 1;
    }
    break;
  }
  if (extension.empty()) {
    constexpr std::size_t count = sizeof(kExtensions) / sizeof(kExtensions[0]);
    extension = kExtensions[(size == 0 ? 0 : data[size - 1]) % count];
  }
  if (target == nullptr) target = &kTargets[size % (sizeof(kTargets) / sizeof(kTargets[0]))];

  std::vector<libassimp::NamedBytes> files;
  files.push_back({"input." + extension, libassimp::Bytes(data + offset, data + size)});
  libassimp::Plan plan(
      "input." + extension, std::move(files), {}, kPostProcess,
      {{target->format, target->nativeId, {}}},
      [](const std::string&, libassimp::Bytes&) { return libassimp::ResolveStatus::Missing; });
  plan.run();
  return 0;
}
