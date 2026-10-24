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

// The plain-C++ core the embind layer and the native ctest binary both call.

#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <variant>
#include <vector>

#include "memory-io.hpp"

struct aiExportFormatDesc;
struct aiImporterDesc;

namespace libassimp {

using Matrix = std::array<double, 16>;
using PropertyValue = std::variant<bool, int, double, std::string, Matrix>;
using Properties = std::vector<std::pair<std::string, PropertyValue>>;

struct FormatInfo {
  std::string id;
  std::string extension;
  std::string description;
};

struct Target {
  std::string format;
  std::string nativeId;
  Properties properties;
  /** Primary output name; empty keeps the legacy `result.<extension>`. */
  std::string outputName;
};

struct ConvertedFormat {
  std::string format;
  std::vector<NamedBytes> files;
};

enum class ProgressPhase : int { None = 0, Importing = 1, PostProcessing = 2, Exporting = 3 };

/** One message assimp's logger reported at warning or error severity during a successful run. */
struct Warning {
  bool error = false;
  ProgressPhase phase = ProgressPhase::Importing;
  int formatIndex = -1;
  std::string message;
};

/** Wall time per phase of the final attempt, in milliseconds. */
struct Timings {
  double import = 0;
  double postProcess = 0;
  double exportAll = 0;
};

struct Result {
  bool ok = false;
  std::string code;
  std::string message;
  int formatIndex = -1;
  std::string format;
  std::vector<ConvertedFormat> formats;
  std::vector<Warning> warnings;
  Timings timings;
};

enum class PlanStatus : int { Pending = -1, Completed = 1, Failed = 2, Aborted = 3 };

/** Receives throttled progress; `formatIndex` is -1 outside the export phase. */
using ProgressSink = std::function<void(ProgressPhase phase, int step, int total, int formatIndex)>;

/** At most this many warnings are kept per run; the rest are counted in a final summary warning. */
constexpr std::size_t kMaxWarnings = 64;

#ifdef LIBASSIMP_CPP_COVERAGE

struct PhaseDiagnostics {
  using Duration = std::chrono::steady_clock::duration;
  Duration resolverWait{};
  std::array<Duration, 3> phases{};
  std::array<bool, 3> observed{};
};
#endif

/** Owned request bytes/configuration. Each run reconstructs attempt-local Assimp state. */
class Plan {
 public:
  Plan(std::string entryName, std::vector<NamedBytes> files, Properties importProperties,
       unsigned int postProcess, std::vector<Target> targets, Resolver resolve);
  PlanStatus run();
  PlanStatus run(Resolver resolve);
  void cancel();
  /** Drop the entry file's bytes once import succeeds. Only safe when the run cannot replay. */
  void setReleaseEntryAfterImport(bool release) { releaseEntry_ = release; }
  /** Stream every export output to `sink` instead of collecting it in memory. */
  void setOutputSink(OutputSink sink) { sink_ = std::move(sink); }
  /** Report progress to `sink`, at most once per `interval` between phase boundaries. */
  void setProgressSink(ProgressSink sink, std::chrono::milliseconds interval) {
    progress_ = std::move(sink);
    progressInterval_ = interval;
  }
  const Result& result() const { return result_; }
  std::size_t importAttempts() const { return importAttempts_.load(); }
#ifdef LIBASSIMP_CPP_COVERAGE
  const PhaseDiagnostics& phaseDiagnostics() const { return phaseDiagnostics_; }
#endif

 private:
  std::string entryName_;
  std::deque<NamedBytes> files_;
  Properties importProperties_;
  unsigned int postProcess_;
  std::vector<Target> targets_;
  Resolver resolve_;
  std::string pendingName_;
  bool releaseEntry_ = false;
  OutputSink sink_;
  ProgressSink progress_;
  std::chrono::milliseconds progressInterval_{0};
  Result result_;
  std::atomic<std::size_t> importAttempts_{0};
  std::atomic<bool> cancelled_{false};
#ifdef LIBASSIMP_CPP_COVERAGE
  PhaseDiagnostics phaseDiagnostics_;
#endif
};

std::vector<FormatInfo> importFormats();
std::vector<FormatInfo> exportFormats();

namespace detail {

bool exportFormatMatches(const aiExportFormatDesc* description, const std::string& id);
void appendImportFormats(std::vector<FormatInfo>& formats, const aiImporterDesc* description);
void appendExportFormat(std::vector<FormatInfo>& formats, const aiExportFormatDesc* description);

#ifdef LIBASSIMP_CPP_COVERAGE
void blockNextProgress(ProgressPhase phase);
ProgressPhase progressBlocked();
void releaseProgress();
#endif

}  // namespace detail

}  // namespace libassimp
