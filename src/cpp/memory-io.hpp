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

// An assimp IOSystem backed by staged random-access bytes plus a file-level
// resolver. Parser reads and seeks stay entirely inside Wasm.

#pragma once

#include <assimp/IOStream.hpp>
#include <assimp/IOSystem.hpp>
#include <assimp/MemoryIOWrapper.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace libassimp {

using Bytes = std::vector<std::uint8_t>;

/** One named payload, in or out. */
struct NamedBytes {
  std::string name;
  Bytes bytes;
  /** Non-zero when the bytes went to the host through an OutputSink instead of `bytes`. */
  std::uint32_t hostFile = 0;
  /** Final length of a host file; equal to `bytes.size()` otherwise. */
  std::size_t size = 0;
};

/** Receives `size` bytes written at `offset` of streamed output `file`. Returns false on failure. */
using OutputSink = std::function<bool(std::uint32_t file, std::size_t offset, const std::uint8_t* data,
                                      std::size_t size)>;

/**
 * Output bytes in fixed-size chunks. Growth never copies, and with a sink every chunk below the
 * write position leaves Wasm as soon as it is complete; a later seek into it writes straight through.
 */
class OutputFile {
 public:
  static constexpr std::size_t kChunk = std::size_t(1) << 20;

  OutputFile(std::string name, const OutputSink* sink, std::uint32_t id)
      : name_(std::move(name)), sink_(sink), id_(id) {}

  bool write(std::size_t offset, const std::uint8_t* data, std::size_t size) {
    size_ = std::max(size_, offset + size);
    while (size != 0) {
      const std::size_t index = offset / kChunk;
      const std::size_t within = offset % kChunk;
      const std::size_t part = std::min(size, kChunk - within);
      if (index < flushed_) {
        if (!(*sink_)(id_, offset, data, part)) return false;
      } else {
        std::memcpy(chunk(index) + within, data, part);
      }
      offset += part;
      data += part;
      size -= part;
    }
    return true;
  }

  /** Grow to `size`, zero-filled, as a seek past the end does. */
  void extend(std::size_t size) { size_ = std::max(size_, size); }

  /** Hand every complete chunk below `position` to the sink. */
  bool release(std::size_t position) {
    if (sink_ == nullptr) return true;
    while ((flushed_ + 1) * kChunk <= position) {
      if (!(*sink_)(id_, flushed_ * kChunk, chunk(flushed_), kChunk)) return false;
      chunks_[flushed_].reset();
      ++flushed_;
    }
    return true;
  }

  /** Move the file out: stream the tail to the sink, or gather the chunks into exact-size bytes. */
  NamedBytes take() {
    NamedBytes file{name_, {}, sink_ == nullptr ? 0u : id_, size_};
    if (sink_ == nullptr) file.bytes.reserve(size_);
    for (std::size_t index = flushed_, offset = flushed_ * kChunk; offset < size_; ++index, offset += kChunk) {
      const std::size_t part = std::min(kChunk, size_ - offset);
      const std::uint8_t* bytes = chunk(index);
      if (sink_ != nullptr) {
        if (!(*sink_)(id_, offset, bytes, part)) throw std::runtime_error("Could not hand an output to the host.");
      } else {
        file.bytes.insert(file.bytes.end(), bytes, bytes + part);
      }
      chunks_[index].reset();
    }
    chunks_.clear();
    return file;
  }

  const std::string& name() const { return name_; }
  std::size_t size() const { return size_; }

 private:
  std::uint8_t* chunk(std::size_t index) {
    if (chunks_.size() <= index) chunks_.resize(index + 1);
    if (!chunks_[index]) chunks_[index].reset(new std::uint8_t[kChunk]());
    return chunks_[index].get();
  }

  std::string name_;
  const OutputSink* sink_;
  std::uint32_t id_;
  std::vector<std::unique_ptr<std::uint8_t[]>> chunks_;
  std::size_t flushed_ = 0;
  std::size_t size_ = 0;
};

enum class ResolveStatus : int {
  Pending = -1,
  Missing = 0,
  Found = 1,
  Failed = 2,
  Aborted = 3,
};

/** Sidecar loader. Pending is reserved for non-JSPI Wasm replay. */
using Resolver = std::function<ResolveStatus(const std::string& name, Bytes& out)>;

/** Everything one convert call reads and writes. Both IOSystems below share exactly one of these. */
class MemoryFiles {
 public:
  MemoryFiles(std::deque<NamedBytes>& inputs, Resolver resolve, const OutputSink* sink = nullptr,
              std::uint32_t* nextHostFile = nullptr)
      : inputs_(inputs), resolve_(std::move(resolve)), sink_(sink), nextHostFile_(nextHostFile) {
    for (const NamedBytes& input : inputs_) index(input);
  }

  /** Exact name, then a unique basename, then the host callback. Both outcomes are cached. */
  const Bytes* find(const std::string& name) {
    if (pending_ || terminal_.has_value()) return nullptr;
    const auto exact = byName_.find(name);
    if (exact != byName_.end()) return exact->second;
    const auto base = byBasename_.find(basename(name));
    if (base != byBasename_.end() && base->second != nullptr) return base->second;
    if (!resolve_ || missing_.count(name) != 0) return nullptr;
    Bytes resolved;
    ResolveStatus status;
    try {
      status = resolve_(name, resolved);
    } catch (...) {
      terminal_ = ResolveStatus::Failed;
      terminalName_ = name;
      throw;
    }
    if (status == ResolveStatus::Pending) {
      pending_ = true;
      pendingName_ = name;
      return nullptr;
    }
    if (status == ResolveStatus::Missing) {
      missing_.insert(name);
      return nullptr;
    }
    if (status != ResolveStatus::Found) {
      terminal_ = status;
      terminalName_ = name;
      return nullptr;
    }
    inputs_.push_back(NamedBytes{name, std::move(resolved)});
    index(inputs_.back());
    return &inputs_.back().bytes;
  }

  /** The write target for `name`, created on first open. */
  OutputFile& output(const std::string& name) {
    const auto found = outputIndex_.find(name);
    if (found != outputIndex_.end()) return outputs_[found->second];
    outputIndex_.emplace(name, outputs_.size());
    outputs_.emplace_back(name, sink_, sink_ == nullptr ? 0u : (*nextHostFile_)++);
    return outputs_.back();
  }

  bool wrote(const std::string& name) const { return outputIndex_.count(name) != 0; }

  /** Answer `name` as missing without ever asking the host: used for names we are about to write. */
  void neverResolve(const std::string& name) { missing_.insert(name); }

  /** Everything the exporter wrote, in write order. */
  const std::deque<OutputFile>& outputs() const { return outputs_; }

  /** Moves every output out, `primary` first and the rest in write order. Call once, after the exporter is gone. */
  std::vector<NamedBytes> takeOutputs(const std::string& primary) {
    std::vector<NamedBytes> files;
    files.reserve(outputs_.size());
    const auto found = outputIndex_.find(primary);
    const std::size_t primaryIndex = found == outputIndex_.end() ? outputs_.size() : found->second;
    if (primaryIndex < outputs_.size()) files.push_back(outputs_[primaryIndex].take());
    for (std::size_t index = 0; index < outputs_.size(); ++index) {
      if (index != primaryIndex) files.push_back(outputs_[index].take());
    }
    outputs_.clear();
    outputIndex_.clear();
    return files;
  }

  bool pending() const { return pending_; }
  const std::string& pendingName() const { return pendingName_; }
  const std::optional<ResolveStatus>& terminal() const { return terminal_; }
  const std::string& terminalName() const { return terminalName_; }

  static std::string basename(const std::string& path) {
    const std::size_t slash = path.find_last_of("/\\");
    return slash == std::string::npos ? path : path.substr(slash + 1);
  }

 private:
  // A basename shared by two inputs is ambiguous and maps to nullptr.
  void index(const NamedBytes& input) {
    byName_.emplace(input.name, &input.bytes);
    const auto inserted = byBasename_.emplace(basename(input.name), &input.bytes);
    if (!inserted.second) inserted.first->second = nullptr;
  }

  // Deques, not vectors: streams hold pointers into these while assimp keeps opening more files.
  std::deque<NamedBytes>& inputs_;
  std::deque<OutputFile> outputs_;
  std::unordered_map<std::string, const Bytes*> byName_;
  std::unordered_map<std::string, const Bytes*> byBasename_;
  std::unordered_map<std::string, std::size_t> outputIndex_;
  std::unordered_set<std::string> missing_;
  Resolver resolve_;
  const OutputSink* sink_;
  std::uint32_t* nextHostFile_;
  bool pending_ = false;
  std::string pendingName_;
  std::optional<ResolveStatus> terminal_;
  std::string terminalName_;
};

/** Append-and-seek stream over one output file. */
class MemoryWriteStream : public Assimp::IOStream {
 public:
  explicit MemoryWriteStream(OutputFile& out) : out_(out) {}

  std::size_t Read(void*, std::size_t, std::size_t) override { return 0; }

  std::size_t Write(const void* buffer, std::size_t size, std::size_t count) override {
    if (size != 0 && count > std::numeric_limits<std::size_t>::max() / size) return 0;
    const std::size_t total = size * count;
    if (total > std::numeric_limits<std::size_t>::max() - position_) return 0;
    if (!out_.write(position_, static_cast<const std::uint8_t*>(buffer), total)) return 0;
    position_ += total;
    return out_.release(position_) ? count : 0;
  }

  aiReturn Seek(std::size_t offset, aiOrigin origin) override {
    // aiOrigin_END counts backwards from the end, matching Assimp::MemoryIOStream.
    if (origin == aiOrigin_END && offset > out_.size()) return AI_FAILURE;
    if (origin == aiOrigin_CUR && offset > std::numeric_limits<std::size_t>::max() - position_) {
      return AI_FAILURE;
    }
    const std::size_t target = origin == aiOrigin_CUR  ? position_ + offset
                               : origin == aiOrigin_END ? out_.size() - offset
                                                        : offset;
    out_.extend(target);
    position_ = target;
    return AI_SUCCESS;
  }

  std::size_t Tell() const override { return position_; }
  std::size_t FileSize() const override { return out_.size(); }
  void Flush() override {}

 private:
  OutputFile& out_;
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
