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

// One owned plan imports a scene once and exports its ordered targets. Only
// non-JSPI Wasm may replay after a Pending result.

#include "libassimp.hpp"

#include <assimp/Exporter.hpp>
#include <assimp/Importer.hpp>
#include <assimp/ProgressHandler.hpp>
#include <assimp/cimport.h>
#include <assimp/importerdesc.h>
#include <assimp/matrix4x4.h>
#include <assimp/scene.h>

#include <exception>
#ifdef LIBASSIMP_CPP_COVERAGE
#include <condition_variable>
#include <mutex>
#endif
#include <sstream>
#include <stdexcept>
#include <type_traits>
#include <utility>

namespace libassimp {
namespace {

static_assert(std::is_same_v<ai_real, float>, "TypeScript validation assumes float32 ai_real storage");

#ifdef LIBASSIMP_CPP_COVERAGE
using Clock = std::chrono::steady_clock;
std::atomic<ProgressPhase> coverageBlockPhase{ProgressPhase::None};
std::atomic<ProgressPhase> coverageBlockedPhase{ProgressPhase::None};
std::mutex progressMutex;
std::condition_variable progressCondition;
bool releaseBlockedProgress = false;
#endif

class CancelProgress final : public Assimp::ProgressHandler {
 public:
#ifdef LIBASSIMP_CPP_COVERAGE
  CancelProgress(const std::atomic<bool>& cancelled, PhaseDiagnostics& diagnostics,
                 ProgressPhase phase)
      : cancelled_(cancelled), diagnostics_(diagnostics), phase_(phase) {}
#else
  explicit CancelProgress(const std::atomic<bool>& cancelled) : cancelled_(cancelled) {}
#endif

  bool Update(float) noexcept override {
#ifdef LIBASSIMP_CPP_COVERAGE
    ProgressPhase requested = phase_;
    if (coverageBlockPhase.compare_exchange_strong(requested, ProgressPhase::None)) {
      std::unique_lock<std::mutex> lock(progressMutex);
      coverageBlockedPhase.store(phase_);
      progressCondition.wait(lock, [&] { return releaseBlockedProgress || cancelled_.load(); });
      coverageBlockedPhase.store(ProgressPhase::None);
    }
#endif
    return !cancelled_.load();
  }

#ifdef LIBASSIMP_CPP_COVERAGE
  bool UpdateFileRead(int currentStep, int numberOfSteps) override {
    observe(ProgressPhase::Importing, currentStep, numberOfSteps);
    const bool keepGoing = Assimp::ProgressHandler::UpdateFileRead(currentStep, numberOfSteps);
    if (currentStep == numberOfSteps) phase_ = ProgressPhase::PostProcessing;
    return keepGoing;
  }

  bool UpdatePostProcess(int currentStep, int numberOfSteps) override {
    observe(ProgressPhase::PostProcessing, currentStep, numberOfSteps);
    return Assimp::ProgressHandler::UpdatePostProcess(currentStep, numberOfSteps);
  }

  bool UpdateFileWrite(int currentStep, int numberOfSteps) override {
    observe(ProgressPhase::Exporting, currentStep, numberOfSteps);
    return Assimp::ProgressHandler::UpdateFileWrite(currentStep, numberOfSteps);
  }

  void finish() {
    const Clock::time_point now = Clock::now();
    for (std::size_t index = 0; index < boundaries_.size(); ++index) close(index, now);
  }

 private:
  struct Boundary {
    Clock::time_point started;
    PhaseDiagnostics::Duration resolverAtStart{};
    bool seen = false;
    bool open = false;
  };

  void observe(ProgressPhase phase, int currentStep, int numberOfSteps) {
    phase_ = phase;
    const std::size_t index = static_cast<std::size_t>(phase) - 1;
    Boundary& boundary = boundaries_[index];
    const Clock::time_point now = Clock::now();
    if (!boundary.seen) {
      boundary.started = now;
      boundary.resolverAtStart = diagnostics_.resolverWait;
      boundary.seen = true;
      boundary.open = true;
      diagnostics_.observed[index] = true;
    }
    if (currentStep == numberOfSteps) close(index, now);
  }

  void close(std::size_t index, Clock::time_point now) {
    Boundary& boundary = boundaries_[index];
    if (!boundary.open) return;
    diagnostics_.phases[index] +=
        now - boundary.started - (diagnostics_.resolverWait - boundary.resolverAtStart);
    boundary.open = false;
  }
#endif

 private:
  const std::atomic<bool>& cancelled_;
#ifdef LIBASSIMP_CPP_COVERAGE
  PhaseDiagnostics& diagnostics_;
  ProgressPhase phase_;
  std::array<Boundary, 3> boundaries_{};
#endif
};

const aiExportFormatDesc* findExportFormat(const Assimp::Exporter& exporter, const std::string& id) {
  for (std::size_t index = 0; index < exporter.GetExportFormatCount(); ++index) {
    const aiExportFormatDesc* description = exporter.GetExportFormatDescription(index);
    if (detail::exportFormatMatches(description, id)) return description;
  }
  return nullptr;
}

#ifdef LIBASSIMP_CPP_COVERAGE
void exportNothing(const char*, Assimp::IOSystem*, const aiScene*, const Assimp::ExportProperties*) {}

void exportProbe(const char* path, Assimp::IOSystem* io, const aiScene*,
                 const Assimp::ExportProperties*) {
  Assimp::IOStream* output = io->Open(path, "wb");
  const std::uint8_t byte = 1;
  output->Write(&byte, 1, 1);
  io->Close(output);
  Assimp::IOStream* sidecar = io->Open("coverage.sidecar", "rb");
  if (sidecar == nullptr) return;
  std::uint8_t resolved = 0;
  sidecar->Read(&resolved, 1, 1);
  io->Close(sidecar);
  output = io->Open("result.sidecar", "wb");
  output->Write(&resolved, 1, 1);
  io->Close(output);
}
#endif

Result fail(std::string code, std::string message, int formatIndex = -1, std::string format = {}) {
  Result result;
  result.code = std::move(code);
  result.message = std::move(message);
  result.formatIndex = formatIndex;
  result.format = std::move(format);
  return result;
}

aiMatrix4x4 toMatrix(const Matrix& value) {
  return aiMatrix4x4(
      static_cast<ai_real>(value[0]), static_cast<ai_real>(value[1]),
      static_cast<ai_real>(value[2]), static_cast<ai_real>(value[3]),
      static_cast<ai_real>(value[4]), static_cast<ai_real>(value[5]),
      static_cast<ai_real>(value[6]), static_cast<ai_real>(value[7]),
      static_cast<ai_real>(value[8]), static_cast<ai_real>(value[9]),
      static_cast<ai_real>(value[10]), static_cast<ai_real>(value[11]),
      static_cast<ai_real>(value[12]), static_cast<ai_real>(value[13]),
      static_cast<ai_real>(value[14]), static_cast<ai_real>(value[15]));
}

template <typename TargetProperties>
void applyProperties(const Properties& properties, TargetProperties& target) {
  for (const auto& property : properties) {
    const std::string& name = property.first;
    const PropertyValue& value = property.second;
    std::visit(
        [&](const auto& typed) {
          using Value = std::decay_t<decltype(typed)>;
          if constexpr (std::is_same_v<Value, bool>) {
            target.SetPropertyBool(name.c_str(), typed);
          } else if constexpr (std::is_same_v<Value, int>) {
            target.SetPropertyInteger(name.c_str(), typed);
          } else if constexpr (std::is_same_v<Value, double>) {
            target.SetPropertyFloat(name.c_str(), static_cast<ai_real>(typed));
          } else if constexpr (std::is_same_v<Value, std::string>) {
            target.SetPropertyString(name.c_str(), typed);
          } else {
            target.SetPropertyMatrix(name.c_str(), toMatrix(typed));
          }
        },
        value);
  }
}

std::vector<NamedBytes> orderedOutputs(const MemoryFiles& store, const std::string& primaryName) {
  std::vector<NamedBytes> files;
  for (const NamedBytes& output : store.outputs()) {
    if (output.name == primaryName) files.push_back(output);
  }
  for (const NamedBytes& output : store.outputs()) {
    if (output.name != primaryName) files.push_back(output);
  }
  return files;
}

}  // namespace

Plan::Plan(std::string entryName, std::vector<NamedBytes> files, Properties importProperties,
           unsigned int postProcess, std::vector<Target> targets, Resolver resolve)
    : entryName_(std::move(entryName)),
      importProperties_(std::move(importProperties)),
      postProcess_(postProcess),
      targets_(std::move(targets)),
      resolve_(std::move(resolve)) {
  for (NamedBytes& file : files) files_.push_back(std::move(file));
}

PlanStatus Plan::run() { return run(resolve_); }

void Plan::cancel() {
  cancelled_.store(true);
#ifdef LIBASSIMP_CPP_COVERAGE
  progressCondition.notify_all();
#endif
}

PlanStatus Plan::run(Resolver resolve) {
  result_ = {};
#ifdef LIBASSIMP_CPP_COVERAGE
  phaseDiagnostics_ = {};
  Resolver measuredResolve;
  if (resolve) measuredResolve = [this, resolve = std::move(resolve)](
                                       const std::string& name, Bytes& bytes) {
    const Clock::time_point started = Clock::now();
    try {
      const ResolveStatus status = resolve(name, bytes);
      phaseDiagnostics_.resolverWait += Clock::now() - started;
      return status;
    } catch (...) {
      phaseDiagnostics_.resolverWait += Clock::now() - started;
      throw;
    }
  };
  const Resolver& activeResolve = measuredResolve;
#else
  const Resolver& activeResolve = resolve;
#endif
  const auto cancelled = [&] {
    if (!cancelled_.load()) return false;
    result_ = {};
    return true;
  };
  if (cancelled()) return PlanStatus::Aborted;
  if (files_.empty()) {
    result_ = fail("NO_FILES", "convert needs at least one input file.");
    return PlanStatus::Failed;
  }
  if (targets_.empty()) {
    result_ = fail("INVALID_OPTIONS", "convertFormats needs at least one target.");
    return PlanStatus::Failed;
  }

  const char* phase = "IMPORT_FAILED";
  int activeFormatIndex = -1;
  std::string activeFormat;
  const auto terminalStatus = [&](ResolveStatus status, const std::string& name) {
    if (cancelled() || status == ResolveStatus::Aborted) {
      result_ = {};
      return PlanStatus::Aborted;
    }
    result_ = fail("RESOLVE_FAILED", "Failed to resolve '" + name + "'.", activeFormatIndex, activeFormat);
    return PlanStatus::Failed;
  };
  try {
    if (!pendingName_.empty()) {
      Bytes resolved;
      const ResolveStatus status = activeResolve(pendingName_, resolved);
      if (status == ResolveStatus::Pending) return PlanStatus::Pending;
      if (cancelled() || status == ResolveStatus::Failed || status == ResolveStatus::Aborted) {
        return terminalStatus(status, pendingName_);
      }
      if (status == ResolveStatus::Found) {
        files_.push_back(NamedBytes{pendingName_, std::move(resolved)});
      }
      pendingName_.clear();
    }
    MemoryFiles inputs(files_, activeResolve);
    Assimp::Importer importer;
    applyProperties(importProperties_, importer);
    importer.SetIOHandler(new MemoryIO(inputs, false));
#ifdef LIBASSIMP_CPP_COVERAGE
    auto* const importProgress =
        new CancelProgress(cancelled_, phaseDiagnostics_, ProgressPhase::Importing);
#else
    auto* const importProgress = new CancelProgress(cancelled_);
#endif
    importer.SetProgressHandler(importProgress);
    ++importAttempts_;
    const aiScene* scene = importer.ReadFile(entryName_, postProcess_);
#ifdef LIBASSIMP_CPP_COVERAGE
    importProgress->finish();
#endif
    if (cancelled()) return PlanStatus::Aborted;
    if (inputs.terminal().has_value()) {
      return terminalStatus(*inputs.terminal(), inputs.terminalName());
    }
    if (inputs.pending()) {
      pendingName_ = inputs.pendingName();
      return PlanStatus::Pending;
    }
    if (scene == nullptr) {
      result_ = fail(phase, importer.GetErrorString());
      return PlanStatus::Failed;
    }

    Result completed;
    completed.ok = true;
    completed.formats.reserve(targets_.size());
    for (std::size_t index = 0; index < targets_.size(); ++index) {
      const Target& target = targets_[index];
      activeFormatIndex = static_cast<int>(index);
      activeFormat = target.format;
      phase = "EXPORT_FAILED";
      Assimp::Exporter exporter;
#ifdef LIBASSIMP_CPP_COVERAGE
      exporter.RegisterExporter(
          Assimp::Exporter::ExportFormatEntry("__test_empty", "Coverage-only empty exporter", "empty", exportNothing));
      exporter.RegisterExporter(
          Assimp::Exporter::ExportFormatEntry("__test_probe", "Coverage-only resolver probe", "probe", exportProbe));
#endif
      const aiExportFormatDesc* description = findExportFormat(exporter, target.nativeId);
      if (description == nullptr) {
        std::ostringstream message;
        message << "Unsupported export format '" << target.format << "'.";
        result_ = fail("UNSUPPORTED_FORMAT", message.str(), static_cast<int>(index), target.format);
        return PlanStatus::Failed;
      }

      const std::string outputName = "result." + std::string(description->fileExtension);
      MemoryFiles outputs(files_, activeResolve);
      outputs.neverResolve(outputName);
      Assimp::ExportProperties exportProperties;
      applyProperties(target.properties, exportProperties);
      exporter.SetIOHandler(new MemoryIO(outputs, true));
#ifdef LIBASSIMP_CPP_COVERAGE
      auto* const exportProgress =
          new CancelProgress(cancelled_, phaseDiagnostics_, ProgressPhase::Exporting);
#else
      auto* const exportProgress = new CancelProgress(cancelled_);
#endif
      exporter.SetProgressHandler(exportProgress);
      const aiReturn exported = exporter.Export(scene, target.nativeId, outputName, 0u, &exportProperties);
#ifdef LIBASSIMP_CPP_COVERAGE
      exportProgress->finish();
#endif
      if (cancelled()) return PlanStatus::Aborted;
      if (outputs.terminal().has_value()) {
        return terminalStatus(*outputs.terminal(), outputs.terminalName());
      }
      if (outputs.pending()) {
        pendingName_ = outputs.pendingName();
        return PlanStatus::Pending;
      }
      if (exported != aiReturn_SUCCESS) {
        result_ = fail(phase, exporter.GetErrorString(), static_cast<int>(index), target.format);
        return PlanStatus::Failed;
      }
      std::vector<NamedBytes> files = orderedOutputs(outputs, outputName);
      if (files.empty()) {
        result_ = fail(phase, "The exporter produced no output.", static_cast<int>(index), target.format);
        return PlanStatus::Failed;
      }
      completed.formats.push_back(ConvertedFormat{target.format, std::move(files)});
    }
    result_ = std::move(completed);
    return PlanStatus::Completed;
  } catch (const std::exception& error) {
    if (cancelled()) return PlanStatus::Aborted;
    result_ = fail(phase, error.what(), activeFormatIndex, activeFormat);
  } catch (...) {
    if (cancelled()) return PlanStatus::Aborted;
    result_ = fail(phase, "Unknown error.", activeFormatIndex, activeFormat);
  }
  return PlanStatus::Failed;
}

std::vector<FormatInfo> importFormats() {
  std::vector<FormatInfo> formats;
  for (std::size_t index = 0; index < aiGetImportFormatCount(); ++index) {
    detail::appendImportFormats(formats, aiGetImportFormatDescription(index));
  }
  return formats;
}

std::vector<FormatInfo> exportFormats() {
  Assimp::Exporter exporter;
  std::vector<FormatInfo> formats;
  for (std::size_t index = 0; index < exporter.GetExportFormatCount(); ++index) {
    detail::appendExportFormat(formats, exporter.GetExportFormatDescription(index));
  }
  return formats;
}

namespace detail {

#ifdef LIBASSIMP_CPP_COVERAGE
void blockNextProgress(ProgressPhase phase) {
  {
    const std::lock_guard<std::mutex> lock(progressMutex);
    releaseBlockedProgress = false;
  }
  coverageBlockPhase.store(phase);
}

ProgressPhase progressBlocked() { return coverageBlockedPhase.load(); }

void releaseProgress() {
  {
    const std::lock_guard<std::mutex> lock(progressMutex);
    releaseBlockedProgress = true;
  }
  coverageBlockPhase.store(ProgressPhase::None);
  progressCondition.notify_all();
}
#endif

bool exportFormatMatches(const aiExportFormatDesc* description, const std::string& id) {
  return description != nullptr && id == description->id;
}

void appendImportFormats(std::vector<FormatInfo>& formats, const aiImporterDesc* description) {
  if (description == nullptr || description->mFileExtensions == nullptr) return;
  std::istringstream extensions(description->mFileExtensions);
  for (std::string extension; extensions >> extension;) {
    formats.push_back(FormatInfo{extension, extension, description->mName});
  }
}

void appendExportFormat(std::vector<FormatInfo>& formats, const aiExportFormatDesc* description) {
  if (description == nullptr) return;
  formats.push_back(FormatInfo{description->id, description->fileExtension, description->description});
}

}  // namespace detail

}  // namespace libassimp

#ifdef __EMSCRIPTEN__

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <emscripten/val.h>

#include <cstdint>
#include <memory>
#include <unordered_map>

extern "C" {
__attribute__((import_module("libassimp"), import_name("dispatch"))) int libassimp_host_dispatch(
    int operation, std::uint32_t first, std::uint32_t second);
}

namespace {

using emscripten::val;

constexpr int kResolveBegin = 1;
constexpr int kResolveSize = 2;
constexpr int kResolveCopy = 3;
constexpr int kResolveRelease = 4;
constexpr int kPending = -1;

std::unordered_map<std::uint32_t, std::unique_ptr<libassimp::Plan>> plans;
std::uint32_t nextPlan = 1;

val bytesToJs(const libassimp::Bytes& bytes) {
  return val(emscripten::typed_memory_view(bytes.size(), bytes.data())).call<val>("slice");
}

libassimp::Bytes bytesFromJs(const val& value) {
  return emscripten::convertJSArrayToNumberVector<std::uint8_t>(value);
}

libassimp::PropertyValue propertyFromJs(const val& property) {
  const std::string kind = property["kind"].as<std::string>();
  const val value = property["value"];
  if (kind == "boolean") return value.as<bool>();
  if (kind == "integer") return value.as<int>();
  if (kind == "number") return value.as<double>();
  if (kind == "string") return value.as<std::string>();
  libassimp::Matrix matrix{};
  for (unsigned index = 0; index < matrix.size(); ++index) matrix[index] = value[index].as<double>();
  return matrix;
}

libassimp::Properties propertiesFromJs(const val& values) {
  libassimp::Properties properties;
  const unsigned length = values["length"].as<unsigned>();
  properties.reserve(length);
  for (unsigned index = 0; index < length; ++index) {
    const val property = values[index];
    properties.emplace_back(property["name"].as<std::string>(), propertyFromJs(property));
  }
  return properties;
}

libassimp::ResolveStatus resolveFromHost(const std::string& name, libassimp::Bytes& output) {
  const int handle = libassimp_host_dispatch(
      kResolveBegin, static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(name.data())),
      static_cast<std::uint32_t>(name.size()));
  if (handle == kPending) return libassimp::ResolveStatus::Pending;
  if (handle == 0) return libassimp::ResolveStatus::Missing;
  const int size = libassimp_host_dispatch(kResolveSize, static_cast<std::uint32_t>(handle), 0u);
  if (size < 0) throw std::runtime_error("Resolver returned a negative byte length.");
  output.resize(static_cast<std::size_t>(size));
  const int copied = libassimp_host_dispatch(
      kResolveCopy, static_cast<std::uint32_t>(handle),
      output.empty()
          ? 0u
          : static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(output.data())));
  libassimp_host_dispatch(kResolveRelease, static_cast<std::uint32_t>(handle), 0u);
  if (copied != size) throw std::runtime_error("Resolver copied an unexpected byte length.");
  return libassimp::ResolveStatus::Found;
}

std::uint32_t preparePlanJs(const std::string& entryName, val files, val options) {
  std::vector<libassimp::NamedBytes> inputs;
  const unsigned fileCount = files["length"].as<unsigned>();
  inputs.reserve(fileCount);
  for (unsigned index = 0; index < fileCount; ++index) {
    const val file = files[index];
    inputs.push_back({file["name"].as<std::string>(), bytesFromJs(file["bytes"])});
  }

  std::vector<libassimp::Target> targets;
  const val targetValues = options["targets"];
  const unsigned targetCount = targetValues["length"].as<unsigned>();
  targets.reserve(targetCount);
  for (unsigned index = 0; index < targetCount; ++index) {
    const val target = targetValues[index];
    targets.push_back({target["format"].as<std::string>(), target["nativeId"].as<std::string>(),
                       propertiesFromJs(target["properties"])});
  }

  const std::uint32_t handle = nextPlan++;
  plans.emplace(handle, std::make_unique<libassimp::Plan>(
                            entryName, std::move(inputs), propertiesFromJs(options["importProperties"]),
                            options["postProcess"].as<unsigned>(), std::move(targets), resolveFromHost));
  return handle;
}

val takePlanResultJs(std::uint32_t handle) {
  const auto found = plans.find(handle);
  if (found == plans.end()) throw std::runtime_error("Unknown conversion plan.");
  const libassimp::Result& result = found->second->result();
  val output = val::object();
  output.set("ok", result.ok);
  output.set("code", result.code);
  output.set("message", result.message);
  if (result.formatIndex >= 0) output.set("formatIndex", result.formatIndex);
  if (!result.format.empty()) output.set("format", result.format);
  val formats = val::array();
  for (const libassimp::ConvertedFormat& converted : result.formats) {
    val format = val::object();
    format.set("format", converted.format);
    val files = val::array();
    for (const libassimp::NamedBytes& file : converted.files) {
      val item = val::object();
      item.set("name", file.name);
      item.set("bytes", bytesToJs(file.bytes));
      files.call<void>("push", item);
    }
    format.set("files", files);
    formats.call<void>("push", format);
  }
  output.set("formats", formats);
  return output;
}

void destroyPlanJs(std::uint32_t handle) { plans.erase(handle); }

}  // namespace

extern "C" EMSCRIPTEN_KEEPALIVE int libassimp_run_plan(std::uint32_t handle) {
  const auto found = plans.find(handle);
  if (found == plans.end()) return static_cast<int>(libassimp::PlanStatus::Failed);
  return static_cast<int>(found->second->run());
}

EMSCRIPTEN_BINDINGS(libassimp) {
  emscripten::function("preparePlan", &preparePlanJs);
  emscripten::function("takePlanResult", &takePlanResultJs);
  emscripten::function("destroyPlan", &destroyPlanJs);
}

#endif  // __EMSCRIPTEN__
