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

// An assimp IOSystem backed by an in-memory file map plus a synchronous host
// callback for anything the caller did not hand over up front.

#pragma once

#include <assimp/IOStream.hpp>
#include <assimp/IOSystem.hpp>
#include <assimp/MemoryIOWrapper.h>

#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace libassimp {

using Bytes = std::vector<std::uint8_t>;

/** One named payload, in or out. */
struct NamedBytes {
  std::string name;
  Bytes bytes;
};

/** Sidecar loader. Returns false when the host cannot supply `name`. Synchronous by contract. */
using Resolver = std::function<bool(const std::string& name, Bytes& out)>;

/** Everything one convert call reads and writes. Both IOSystems below share exactly one of these. */
class MemoryFiles {
 public:
  MemoryFiles(std::vector<NamedBytes> inputs, Resolver resolve) : resolve_(std::move(resolve)) {
    for (NamedBytes& input : inputs) inputs_.push_back(std::move(input));
  }

  /** Exact name, then basename, then the host callback. Both outcomes are cached. */
  const Bytes* find(const std::string& name) {
    for (const NamedBytes& input : inputs_) {
      if (input.name == name) return &input.bytes;
    }
    const std::string base = basename(name);
    for (const NamedBytes& input : inputs_) {
      if (basename(input.name) == base) return &input.bytes;
    }
    if (!resolve_ || missing_.count(name) != 0) return nullptr;
    Bytes resolved;
    if (!resolve_(name, resolved)) {
      missing_.insert(name);
      return nullptr;
    }
    inputs_.push_back(NamedBytes{name, std::move(resolved)});
    return &inputs_.back().bytes;
  }

  /** The write target for `name`, created on first open. */
  Bytes& output(const std::string& name) {
    for (NamedBytes& out : outputs_) {
      if (out.name == name) return out.bytes;
    }
    outputs_.push_back(NamedBytes{name, Bytes{}});
    return outputs_.back().bytes;
  }

  bool wrote(const std::string& name) const {
    for (const NamedBytes& out : outputs_) {
      if (out.name == name) return true;
    }
    return false;
  }

  /** Answer `name` as missing without ever asking the host: used for names we are about to write. */
  void neverResolve(const std::string& name) { missing_.insert(name); }

  /** Everything the exporter wrote, in write order. */
  const std::deque<NamedBytes>& outputs() const { return outputs_; }

  static std::string basename(const std::string& path) {
    const std::size_t slash = path.find_last_of("/\\");
    return slash == std::string::npos ? path : path.substr(slash + 1);
  }

 private:
  // Deques, not vectors: streams hold pointers into these while assimp keeps opening more files.
  std::deque<NamedBytes> inputs_;
  std::deque<NamedBytes> outputs_;
  std::unordered_set<std::string> missing_;
  Resolver resolve_;
};

/** Append-and-seek stream over one output buffer. */
class MemoryWriteStream : public Assimp::IOStream {
 public:
  explicit MemoryWriteStream(Bytes& out) : out_(out) {}

  std::size_t Read(void*, std::size_t, std::size_t) override { return 0; }

  std::size_t Write(const void* buffer, std::size_t size, std::size_t count) override {
    const std::size_t total = size * count;
    if (position_ + total > out_.size()) out_.resize(position_ + total);
    std::memcpy(out_.data() + position_, buffer, total);
    position_ += total;
    return count;
  }

  aiReturn Seek(std::size_t offset, aiOrigin origin) override {
    // aiOrigin_END counts backwards from the end, matching Assimp::MemoryIOStream.
    const std::size_t target = origin == aiOrigin_CUR  ? position_ + offset
                               : origin == aiOrigin_END ? out_.size() - offset
                                                        : offset;
    if (origin == aiOrigin_END && offset > out_.size()) return AI_FAILURE;
    if (target > out_.size()) out_.resize(target);
    position_ = target;
    return AI_SUCCESS;
  }

  std::size_t Tell() const override { return position_; }
  std::size_t FileSize() const override { return out_.size(); }
  void Flush() override {}

 private:
  Bytes& out_;
  std::size_t position_ = 0;
};

/** Reads always come from the file map; writes are collected only when `writable`. */
class MemoryIO : public Assimp::IOSystem {
 public:
  MemoryIO(MemoryFiles& files, bool writable) : files_(files), writable_(writable) {}

  bool Exists(const char* file) const override {
    return (writable_ && files_.wrote(file)) || files_.find(file) != nullptr;
  }

  char getOsSeparator() const override { return '/'; }

  Assimp::IOStream* Open(const char* file, const char* mode) override {
    if (writable_ && (std::strchr(mode, 'w') != nullptr || std::strchr(mode, 'a') != nullptr)) {
      return new MemoryWriteStream(files_.output(file));
    }
    const Bytes* bytes = files_.find(file);
    if (bytes == nullptr) return nullptr;
    return new Assimp::MemoryIOStream(bytes->data(), bytes->size());
  }

  void Close(Assimp::IOStream* stream) override { delete stream; }

  bool ComparePaths(const char* one, const char* second) const override {
    return MemoryFiles::basename(one) == MemoryFiles::basename(second);
  }

  // ponytail: there is no directory tree to create or walk, so the base class'
  // stack-of-directories defaults are exactly right.

 private:
  MemoryFiles& files_;
  bool writable_;
};

}  // namespace libassimp
