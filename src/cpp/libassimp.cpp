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

// The whole binding: one convert entry point and one format table, over an
// in-memory IOSystem. The core is plain C++ so the native ctest leg exercises
// the same code path; the embind layer at the bottom is a thin adapter.

#include "libassimp.hpp"

#include <assimp/Exporter.hpp>
#include <assimp/Importer.hpp>
#include <assimp/cimport.h>
#include <assimp/importerdesc.h>
#include <assimp/postprocess.h>
#include <assimp/scene.h>

#include <exception>
#include <sstream>
#include <utility>

#include "memory-io.hpp"

namespace libassimp {
namespace {

// Fixed in 0.1.0; a postProcess option is an additive 0.2.0 change.
constexpr unsigned int kPostProcess = aiProcess_Triangulate | aiProcess_GenUVCoords |
                                      aiProcess_JoinIdenticalVertices | aiProcess_SortByPType;

/** Friendly names for assimp export ids. `glb`/`gltf` name glTF 2.0, so glTF 1.0 moves to `glb1`/`gltf1`. */
std::string resolveAlias(const std::string& format) {
  if (format == "glb") return "glb2";
  if (format == "gltf") return "gltf2";
  if (format == "glb1") return "glb";
  if (format == "gltf1") return "gltf";
  if (format == "step") return "stp";
  if (format == "dae") return "collada";
  return format;
}

const aiExportFormatDesc* findExportFormat(const Assimp::Exporter& exporter, const std::string& id) {
  for (std::size_t index = 0; index < exporter.GetExportFormatCount(); ++index) {
    const aiExportFormatDesc* description = exporter.GetExportFormatDescription(index);
    if (description != nullptr && id == description->id) return description;
  }
  return nullptr;
}

Result fail(std::string code, std::string message) {
  Result result;
  result.code = std::move(code);
  result.message = std::move(message);
  return result;
}

void applyProperties(const Properties& properties, Assimp::ExportProperties& target) {
  for (const auto& [name, value] : properties) {
    if (const bool* boolean = std::get_if<bool>(&value)) target.SetPropertyBool(name.c_str(), *boolean);
    else if (const int* integer = std::get_if<int>(&value)) target.SetPropertyInteger(name.c_str(), *integer);
    else if (const double* number = std::get_if<double>(&value))
      target.SetPropertyFloat(name.c_str(), static_cast<ai_real>(*number));
    else target.SetPropertyString(name.c_str(), std::get<std::string>(value));
  }
}

}  // namespace

std::vector<FormatInfo> importFormats() {
  std::vector<FormatInfo> formats;
  for (std::size_t index = 0; index < aiGetImportFormatCount(); ++index) {
    const aiImporterDesc* description = aiGetImportFormatDescription(index);
    if (description == nullptr || description->mFileExtensions == nullptr) continue;
    // Importers have no stable id, only a space-separated extension list; one entry per extension.
    std::istringstream extensions(description->mFileExtensions);
    for (std::string extension; extensions >> extension;) {
      formats.push_back(FormatInfo{extension, extension, description->mName});
    }
  }
  return formats;
}

std::vector<FormatInfo> exportFormats() {
  Assimp::Exporter exporter;
  std::vector<FormatInfo> formats;
  for (std::size_t index = 0; index < exporter.GetExportFormatCount(); ++index) {
    const aiExportFormatDesc* description = exporter.GetExportFormatDescription(index);
    if (description == nullptr) continue;
    formats.push_back(FormatInfo{description->id, description->fileExtension, description->description});
  }
  return formats;
}

Result convert(const std::string& entryName, std::vector<NamedBytes> files, const std::string& format,
               const Properties& properties, const Resolver& resolve) {
  if (files.empty()) return fail("NO_FILES", "convert needs at least one input file.");

  MemoryFiles store(std::move(files), resolve);
  Assimp::Exporter exporter;

  const std::string formatId = resolveAlias(format);
  const aiExportFormatDesc* description = findExportFormat(exporter, formatId);
  if (description == nullptr) {
    std::ostringstream message;
    message << "Unsupported export format '" << format << "'. This build exports:";
    for (const FormatInfo& info : exportFormats()) message << ' ' << info.id;
    message << ". Aliases: glb, gltf, glb1, gltf1, step, dae.";
    return fail("UNSUPPORTED_FORMAT", message.str());
  }
  const std::string outputName = "result." + std::string(description->fileExtension);
  // Exporters stat their own output before writing; the host's resolve callback should never
  // be asked for a name we are about to produce.
  store.neverResolve(outputName);

  const char* phase = "IMPORT_FAILED";
  try {
    Assimp::Importer importer;
    importer.SetIOHandler(new MemoryIO(store, false));
    const aiScene* scene = importer.ReadFile(entryName, kPostProcess);
    if (scene == nullptr) return fail(phase, importer.GetErrorString());

    phase = "EXPORT_FAILED";
    Assimp::ExportProperties exportProperties;
    exportProperties.SetPropertyBool("JSON_SKIP_WHITESPACES", true);
    applyProperties(properties, exportProperties);
    exporter.SetIOHandler(new MemoryIO(store, true));
    if (exporter.Export(scene, formatId, outputName, 0u, &exportProperties) != aiReturn_SUCCESS) {
      return fail(phase, exporter.GetErrorString());
    }
  } catch (const std::exception& error) {
    return fail(phase, error.what());
  } catch (...) {
    return fail(phase, "Unknown error.");
  }

  Result result;
  result.ok = true;
  // Primary output first, sidecars (glTF .bin, OBJ .mtl) after, in write order.
  for (const NamedBytes& output : store.outputs()) {
    if (output.name == outputName) result.files.push_back(output);
  }
  for (const NamedBytes& output : store.outputs()) {
    if (output.name != outputName) result.files.push_back(output);
  }
  if (result.files.empty()) return fail("EXPORT_FAILED", "The exporter produced no output.");
  return result;
}

}  // namespace libassimp

#ifdef __EMSCRIPTEN__

#include <emscripten/bind.h>
#include <emscripten/val.h>

namespace {

using emscripten::val;

val bytesToJs(const libassimp::Bytes& bytes) {
  // A view into the heap would dangle the moment the module grows memory, so hand back a copy.
  return val(emscripten::typed_memory_view(bytes.size(), bytes.data())).call<val>("slice");
}

libassimp::Bytes bytesFromJs(const val& value) {
  return emscripten::convertJSArrayToNumberVector<std::uint8_t>(value);
}

val formatsToJs(const std::vector<libassimp::FormatInfo>& formats) {
  val list = val::array();
  for (const libassimp::FormatInfo& format : formats) {
    val entry = val::object();
    entry.set("id", format.id);
    entry.set("extension", format.extension);
    entry.set("description", format.description);
    list.call<void>("push", entry);
  }
  return list;
}

val convertJs(const std::string& entryName, val files, const std::string& format, val properties, val resolve) {
  std::vector<libassimp::NamedBytes> inputs;
  const unsigned length = files["length"].as<unsigned>();
  inputs.reserve(length);
  for (unsigned index = 0; index < length; ++index) {
    val file = files[index];
    inputs.push_back(libassimp::NamedBytes{file["name"].as<std::string>(), bytesFromJs(file["bytes"])});
  }

  libassimp::Properties exportProperties;
  if (!properties.isUndefined() && !properties.isNull()) {
    const val keys = val::global("Object").call<val>("keys", properties);
    const unsigned count = keys["length"].as<unsigned>();
    for (unsigned index = 0; index < count; ++index) {
      const std::string key = keys[index].as<std::string>();
      const val value = properties[key];
      const std::string type = value.typeOf().as<std::string>();
      if (type == "boolean") exportProperties.emplace_back(key, value.as<bool>());
      else if (type == "string") exportProperties.emplace_back(key, value.as<std::string>());
      else if (type == "number") {
        if (val::global("Number").call<bool>("isInteger", value)) {
          exportProperties.emplace_back(key, value.as<int>());
        } else {
          exportProperties.emplace_back(key, value.as<double>());
        }
      }
    }
  }

  libassimp::Resolver resolver;
  if (!resolve.isUndefined() && !resolve.isNull()) {
    resolver = [resolve](const std::string& name, libassimp::Bytes& out) {
      const val loaded = resolve(name);
      if (loaded.isUndefined() || loaded.isNull()) return false;
      out = bytesFromJs(loaded);
      return true;
    };
  }

  const libassimp::Result result =
      libassimp::convert(entryName, std::move(inputs), format, exportProperties, resolver);

  val files_out = val::array();
  for (const libassimp::NamedBytes& file : result.files) {
    val entry = val::object();
    entry.set("name", file.name);
    entry.set("bytes", bytesToJs(file.bytes));
    files_out.call<void>("push", entry);
  }
  val output = val::object();
  output.set("ok", result.ok);
  output.set("code", result.code);
  output.set("message", result.message);
  output.set("files", files_out);
  return output;
}

val formatsJs() {
  val output = val::object();
  output.set("import", formatsToJs(libassimp::importFormats()));
  output.set("export", formatsToJs(libassimp::exportFormats()));
  return output;
}

}  // namespace

EMSCRIPTEN_BINDINGS(libassimp) {
  emscripten::function("convert", &convertJs);
  emscripten::function("formats", &formatsJs);
}

#endif  // __EMSCRIPTEN__
