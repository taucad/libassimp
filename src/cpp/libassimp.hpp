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

#include <string>
#include <variant>
#include <vector>

#include "memory-io.hpp"

namespace libassimp {

using PropertyValue = std::variant<bool, int, double, std::string>;
using Properties = std::vector<std::pair<std::string, PropertyValue>>;

struct FormatInfo {
  std::string id;
  std::string extension;
  std::string description;
};

struct Result {
  bool ok = false;
  /** Empty on success, else NO_FILES | UNSUPPORTED_FORMAT | IMPORT_FAILED | EXPORT_FAILED. */
  std::string code;
  std::string message;
  /** Primary output first. */
  std::vector<NamedBytes> files;
};

/** Import `entryName` out of `files` and export it as `format`. Never throws. */
Result convert(const std::string& entryName, std::vector<NamedBytes> files, const std::string& format,
               const Properties& properties, const Resolver& resolve);

std::vector<FormatInfo> importFormats();
std::vector<FormatInfo> exportFormats();

}  // namespace libassimp
