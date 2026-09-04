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

#include <napi.h>

#include <algorithm>
#include <atomic>
#ifdef LIBASSIMP_CPP_COVERAGE
#include <chrono>
#endif
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <cstdint>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <thread>
#include <utility>
#include <vector>

#include "libassimp.hpp"

#ifndef LIBASSIMP_NATIVE_BUILD_IDENTITY
#define LIBASSIMP_STRINGIFY_VALUE(value) #value
#define LIBASSIMP_STRINGIFY(value) LIBASSIMP_STRINGIFY_VALUE(value)
#define LIBASSIMP_NATIVE_BUILD_IDENTITY "unknown-unknown-napi" LIBASSIMP_STRINGIFY(NAPI_VERSION)
#endif

#ifndef LIBASSIMP_PACKAGE_VERSION
#define LIBASSIMP_PACKAGE_VERSION "0.0.0"
#endif

namespace {

constexpr napi_type_tag kPlanType{0xbff5b876d76342c3ULL, 0xa44fd1210e0915d1ULL};

#ifdef LIBASSIMP_CPP_COVERAGE
std::atomic<bool> coverageBlockNextExecute{false};
std::atomic<bool> coverageExecuteBlocked{false};
std::atomic<bool> coverageBlockNextResolve{false};
std::atomic<bool> coverageResolveBlocked{false};
std::atomic<bool> coverageBlockNextJoin{false};
std::atomic<bool> coverageJoinBlocked{false};
std::atomic<std::size_t> coverageJoinWaiters{0};
std::atomic<bool> coverageCloseNextDispatch{false};
std::atomic<bool> coverageCloseNextStageDispatch{false};
std::atomic<std::size_t> coverageOutstandingRequests{0};
std::atomic<std::size_t> coverageTransientBytes{0};
std::atomic<std::size_t> coverageRetainedBytes{0};
std::atomic<std::size_t> coverageStagedBytes{0};
std::mutex coverageExecuteMutex;
std::condition_variable coverageExecuteCondition;
bool coverageExecuteReleased = false;
bool coverageResolveReleased = false;
bool coverageJoinReleased = false;

enum class CoverageFailure : int {
  Promise = 1,
  ThreadSafeFunction = 2,
  Submit = 3,
  Complete = 4,
  UnknownSubmit = 5,
  Reference = 6,
  StageReference = 7,
  StageLength = 8,
  StageElement = 9,
  StageTypedArray = 10,
  External = 11,
  CancelStage = 12,
};
std::atomic<int> coverageFailure{0};

bool takeCoverageFailure(CoverageFailure expected) {
  int value = static_cast<int>(expected);
  return coverageFailure.compare_exchange_strong(value, 0);
}

struct NativeDiagnostics {
  using Duration = std::chrono::steady_clock::duration;
  Duration queueWait{};
  Duration total{};
  libassimp::PhaseDiagnostics phases;
};

double milliseconds(NativeDiagnostics::Duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}
#endif

Napi::Uint8Array uint8ArrayAt(const Napi::Value &value, const char *path) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(value.Env(),
                               std::string(path) + " must be a Uint8Array");
  }
  return value.As<Napi::Uint8Array>();
}

libassimp::Bytes bytesFromJs(const Napi::Value &value, const char *path) {
  const Napi::Uint8Array bytes = uint8ArrayAt(value, path);
  return {bytes.Data(), bytes.Data() + bytes.ElementLength()};
}

Napi::Object objectAt(const Napi::Value &value, const char *path) {
  if (!value.IsObject() || value.IsArray() || value.IsTypedArray()) {
    throw Napi::TypeError::New(value.Env(),
                               std::string(path) + " must be an object");
  }
  return value.As<Napi::Object>();
}

Napi::Array arrayAt(const Napi::Value &value, const char *path) {
  if (!value.IsArray()) {
    throw Napi::TypeError::New(value.Env(),
                               std::string(path) + " must be an array");
  }
  return value.As<Napi::Array>();
}

std::string stringAt(const Napi::Value &value, const char *path) {
  if (!value.IsString()) {
    throw Napi::TypeError::New(value.Env(),
                               std::string(path) + " must be a string");
  }
  return value.As<Napi::String>().Utf8Value();
}

libassimp::PropertyValue propertyValueFromJs(const Napi::Object &property) {
  const std::string kind = stringAt(property.Get("kind"), "property.kind");
  const Napi::Value value = property.Get("value");
  if (kind == "boolean") {
    if (!value.IsBoolean())
      throw Napi::TypeError::New(value.Env(),
                                 "boolean property must be boolean");
    return value.As<Napi::Boolean>().Value();
  }
  if (kind == "integer") {
    if (!value.IsNumber())
      throw Napi::TypeError::New(value.Env(),
                                 "integer property must be a number");
    const double number = value.As<Napi::Number>().DoubleValue();
    const int integer = value.As<Napi::Number>().Int32Value();
    if (number != integer)
      throw Napi::TypeError::New(value.Env(),
                                 "integer property must be an int32");
    return integer;
  }
  if (kind == "number") {
    if (!value.IsNumber())
      throw Napi::TypeError::New(value.Env(),
                                 "number property must be a number");
    const double number = value.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(number) ||
        std::abs(number) > std::numeric_limits<ai_real>::max()) {
      throw Napi::TypeError::New(
          value.Env(), "number property must fit finite ai_real storage");
    }
    return number;
  }
  if (kind == "string")
    return stringAt(value, "string property");
  if (kind != "matrix")
    throw Napi::TypeError::New(value.Env(), "unknown property kind");
  const Napi::Array values = arrayAt(value, "matrix property");
  if (values.Length() != 16)
    throw Napi::TypeError::New(value.Env(), "matrix property needs 16 numbers");
  libassimp::Matrix matrix{};
  for (std::uint32_t index = 0; index < values.Length(); ++index) {
    const Napi::Value element = values.Get(index);
    if (!element.IsNumber())
      throw Napi::TypeError::New(value.Env(),
                                 "matrix property needs 16 numbers");
    matrix[index] = element.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(matrix[index]) ||
        std::abs(matrix[index]) > std::numeric_limits<ai_real>::max()) {
      throw Napi::TypeError::New(value.Env(),
                                 "matrix property needs 16 finite ai_real numbers");
    }
  }
  return matrix;
}

libassimp::Properties propertiesFromJs(const Napi::Value &value) {
  const Napi::Array values = arrayAt(value, "properties");
  libassimp::Properties properties;
  properties.reserve(values.Length());
  for (std::uint32_t index = 0; index < values.Length(); ++index) {
    const Napi::Object property = objectAt(values.Get(index), "property");
    properties.emplace_back(stringAt(property.Get("name"), "property.name"),
                            propertyValueFromJs(property));
  }
  return properties;
}

struct InputFile {
  std::string name;
  std::size_t length;
};

struct ValidatedFiles {
  Napi::Array values;
  std::vector<InputFile> files;
  std::size_t bytes = 0;
};

ValidatedFiles validateFilesFromJs(const Napi::Value &value) {
  const Napi::Array values = arrayAt(value, "files");
  Napi::Array retained = Napi::Array::New(value.Env(), values.Length());
  std::vector<InputFile> files;
  files.reserve(values.Length());
  std::size_t total = 0;
  for (std::uint32_t index = 0; index < values.Length(); ++index) {
    const Napi::Object file = objectAt(values.Get(index), "file");
    const std::string name = stringAt(file.Get("name"), "file.name");
    const Napi::Uint8Array bytes =
        uint8ArrayAt(file.Get("bytes"), "file.bytes");
    files.push_back({name, bytes.ElementLength()});
    total += bytes.ElementLength();
    retained.Set(index, bytes);
  }
  return {retained, std::move(files), total};
}

std::vector<libassimp::Target> targetsFromJs(const Napi::Value &value) {
  const Napi::Array values = arrayAt(value, "options.targets");
  std::vector<libassimp::Target> targets;
  targets.reserve(values.Length());
  for (std::uint32_t index = 0; index < values.Length(); ++index) {
    const Napi::Object target = objectAt(values.Get(index), "target");
    targets.push_back({stringAt(target.Get("format"), "target.format"),
                       stringAt(target.Get("nativeId"), "target.nativeId"),
                       propertiesFromJs(target.Get("properties"))});
  }
  return targets;
}

class Job;

class NativePlan {
public:
  NativePlan(std::string entryName, std::vector<InputFile> files,
             libassimp::Properties importProperties, unsigned int postProcess,
             std::vector<libassimp::Target> targets)
      : entryName_(std::move(entryName)), files_(std::move(files)),
        importProperties_(std::move(importProperties)),
        postProcess_(postProcess), targets_(std::move(targets)) {
    stagingResult_.code = "INVALID_INPUT";
    stagingResult_.message = "Input buffers changed before native admission.";
  }

#ifdef LIBASSIMP_CPP_COVERAGE
  ~NativePlan() { coverageStagedBytes.fetch_sub(stagedBytes_); }
#endif

  bool begin(const std::shared_ptr<Job> &job);
  void end(const Job *job);
  bool busy() const;
  std::shared_ptr<Job> activeJob() const;
  void retainInputs(napi_env env, napi_value values, std::size_t bytes);
  bool stage(napi_env env);
  bool staged() const;
  bool cancelled() const;
  void releaseInputs(napi_env env);
  void releaseIdleInputs(napi_env env);
  libassimp::PlanStatus run(libassimp::Resolver resolve);
  void cancel();
  const libassimp::Result &result() const;
  std::size_t importAttempts() const;
#ifdef LIBASSIMP_CPP_COVERAGE
  void queued();
  void executing();
  NativeDiagnostics diagnostics() const;
#endif

private:
  mutable std::mutex mutex_;
  bool busy_ = false;
  bool cancelled_ = false;
  bool stagingFailed_ = false;
  std::weak_ptr<Job> activeJob_;
  std::string entryName_;
  std::vector<InputFile> files_;
  libassimp::Properties importProperties_;
  unsigned int postProcess_;
  std::vector<libassimp::Target> targets_;
  napi_ref inputValues_ = nullptr;
  std::size_t retainedBytes_ = 0;
  std::unique_ptr<libassimp::Plan> plan_;
  libassimp::Result emptyResult_;
  libassimp::Result stagingResult_;
#ifdef LIBASSIMP_CPP_COVERAGE
  std::size_t stagedBytes_ = 0;
  NativeDiagnostics diagnostics_;
  std::chrono::steady_clock::time_point queuedAt_;
  bool diagnosticsQueued_ = false;
#endif
};

struct PlanHandle {
  std::shared_ptr<NativePlan> plan;
};

struct EnvironmentState {
  napi_env env = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  bool closing = false;
  bool cleanupWalked = false;
  std::uint64_t nextJob = 1;
  std::unordered_map<std::uint64_t, std::shared_ptr<Job>> jobs;
#ifdef LIBASSIMP_CPP_COVERAGE
  bool coverageClosed = false;
#endif

  std::uint64_t add(const std::shared_ptr<Job> &job);
  void remove(std::uint64_t id);
  void finishCleanupIfReady();
};

class ResolveRequest {
public:
  explicit ResolveRequest(std::string requestedName)
      : name(std::move(requestedName)) {
#ifdef LIBASSIMP_CPP_COVERAGE
    ++coverageOutstandingRequests;
#endif
  }

  ~ResolveRequest() {
#ifdef LIBASSIMP_CPP_COVERAGE
    coverageTransientBytes.fetch_sub(bytes_.size());
    --coverageOutstandingRequests;
#endif
  }

  bool settle(libassimp::ResolveStatus status, libassimp::Bytes bytes = {}) {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (settled_)
      return false;
    status_ = status;
    if (status == libassimp::ResolveStatus::Found) {
#ifdef LIBASSIMP_CPP_COVERAGE
      coverageTransientBytes.fetch_add(bytes.size());
#endif
      bytes_ = std::move(bytes);
    }
    settled_ = true;
    condition_.notify_one();
    return true;
  }

  libassimp::ResolveStatus take(libassimp::Bytes &bytes) {
    std::unique_lock<std::mutex> lock(mutex_);
    condition_.wait(lock, [&] { return settled_; });
    if (status_ == libassimp::ResolveStatus::Found) {
#ifdef LIBASSIMP_CPP_COVERAGE
      coverageTransientBytes.fetch_sub(bytes_.size());
#endif
      bytes = std::move(bytes_);
    }
    return status_;
  }

  const std::string name;

private:
  std::mutex mutex_;
  std::condition_variable condition_;
  bool settled_ = false;
  libassimp::ResolveStatus status_ = libassimp::ResolveStatus::Aborted;
  libassimp::Bytes bytes_;
};

struct Event;

class Job final : public std::enable_shared_from_this<Job> {
public:
  explicit Job(std::shared_ptr<NativePlan> plan) : plan_(std::move(plan)) {}

  void setDeferred(napi_deferred deferred) { deferred_ = deferred; }
  void setThreadSafeFunction(napi_threadsafe_function function);
  void execute();
  void cancel(napi_env env, bool environmentClosing);
  void finish(libassimp::PlanStatus status);
  void stage(napi_env env);
  void stageClosed();
  void endPlan() { plan_->end(this); }
  bool cancelled() const;
  libassimp::ResolveStatus resolve(const std::string &name,
                                   libassimp::Bytes &bytes);
  void setReferenced(napi_env env, bool referenced);
#ifdef LIBASSIMP_CPP_COVERAGE
  void closeForCoverage(napi_env env) {
    abortThreadSafeFunction();
    setReferenced(env, true);
  }
#endif

  napi_deferred deferred() const { return deferred_; }

private:
  bool dispatch(Event *event, bool release);
  bool requestStaging();
  void abortThreadSafeFunction();

  std::shared_ptr<NativePlan> plan_;
  napi_deferred deferred_ = nullptr;
  mutable std::mutex mutex_;
  bool cancelled_ = false;
  bool environmentClosing_ = false;
  bool stagingDone_ = false;
  bool stagingSucceeded_ = false;
  std::shared_ptr<ResolveRequest> request_;
  std::condition_variable stagingCondition_;
  std::mutex functionMutex_;
  napi_threadsafe_function function_ = nullptr;
};

enum class EventKind { Stage, Resolve, Complete };

struct Event {
  EventKind kind;
  std::shared_ptr<Job> job;
  std::shared_ptr<ResolveRequest> request;
  libassimp::PlanStatus status = libassimp::PlanStatus::Failed;
};

void Job::setThreadSafeFunction(napi_threadsafe_function function) {
  const std::lock_guard<std::mutex> lock(functionMutex_);
  function_ = function;
}

bool Job::dispatch(Event *event, bool release) {
  napi_status status = napi_closing;
  {
    const std::lock_guard<std::mutex> lock(functionMutex_);
    if (function_ != nullptr) {
      napi_threadsafe_function function = function_;
#ifdef LIBASSIMP_CPP_COVERAGE
      if (event->kind == EventKind::Stage &&
          coverageCloseNextStageDispatch.exchange(false)) {
        napi_release_threadsafe_function(function, napi_tsfn_abort);
        status = napi_closing;
      } else if (event->kind != EventKind::Stage &&
                 coverageCloseNextDispatch.exchange(false)) {
        napi_release_threadsafe_function(function, napi_tsfn_abort);
        status = napi_closing;
      } else
#endif
      status = napi_call_threadsafe_function(function, event,
                                             napi_tsfn_nonblocking);
      if (release || status == napi_closing)
        function_ = nullptr;
      if (release && status != napi_closing)
        napi_release_threadsafe_function(function, napi_tsfn_release);
    }
  }
  if (status == napi_ok)
    return true;
  delete event;
  return false;
}

void Job::abortThreadSafeFunction() {
  napi_threadsafe_function function;
  {
    const std::lock_guard<std::mutex> lock(functionMutex_);
    function = std::exchange(function_, nullptr);
  }
  if (function != nullptr)
    napi_release_threadsafe_function(function, napi_tsfn_abort);
}

void Job::setReferenced(napi_env env, bool referenced) {
  const std::lock_guard<std::mutex> lock(functionMutex_);
  if (function_ == nullptr)
    return;
  if (referenced)
    napi_ref_threadsafe_function(env, function_);
  else
    napi_unref_threadsafe_function(env, function_);
}

bool Job::cancelled() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return cancelled_;
}

void Job::cancel(napi_env env, bool environmentClosing) {
  bool cancelPlan = false;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    environmentClosing_ |= environmentClosing;
    cancelPlan = !std::exchange(cancelled_, true);
    if (request_)
      request_->settle(libassimp::ResolveStatus::Aborted);
  }
  if (cancelPlan)
    plan_->cancel();
  if (env != nullptr)
    plan_->releaseInputs(env);
  stagingCondition_.notify_all();
  if (env != nullptr && !environmentClosing)
    setReferenced(env, true);
#ifdef LIBASSIMP_CPP_COVERAGE
  coverageExecuteCondition.notify_all();
#endif
  if (environmentClosing)
    abortThreadSafeFunction();
}

void Job::stage(napi_env env) {
  const bool succeeded = plan_->stage(env);
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    stagingSucceeded_ = succeeded;
    stagingDone_ = true;
  }
  stagingCondition_.notify_one();
}

void Job::stageClosed() {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    stagingDone_ = true;
  }
  stagingCondition_.notify_one();
}

bool Job::requestStaging() {
  if (plan_->staged())
    return true;
  if (!dispatch(new Event{EventKind::Stage, shared_from_this(), {}}, false))
    return false;
#ifdef LIBASSIMP_CPP_COVERAGE
  if (takeCoverageFailure(CoverageFailure::CancelStage))
    cancel(nullptr, false);
#endif
  std::unique_lock<std::mutex> lock(mutex_);
  stagingCondition_.wait(lock, [&] { return stagingDone_ || cancelled_; });
  return stagingDone_ && stagingSucceeded_;
}

libassimp::ResolveStatus Job::resolve(const std::string &name,
                                      libassimp::Bytes &bytes) {
#ifdef LIBASSIMP_CPP_COVERAGE
  if (coverageBlockNextResolve.exchange(false)) {
    std::unique_lock<std::mutex> lock(coverageExecuteMutex);
    coverageResolveBlocked.store(true);
    coverageExecuteCondition.wait(
        lock, [&] { return coverageResolveReleased || cancelled(); });
    coverageResolveBlocked.store(false);
  }
#endif
  auto request = std::make_shared<ResolveRequest>(name);
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (cancelled_)
      return libassimp::ResolveStatus::Aborted;
    request_ = request;
  }
  if (!dispatch(new Event{EventKind::Resolve, shared_from_this(), request},
                false)) {
    request->settle(libassimp::ResolveStatus::Failed);
  }
  const libassimp::ResolveStatus status = request->take(bytes);
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    request_.reset();
  }
  return status;
}

void Job::execute() {
#ifdef LIBASSIMP_CPP_COVERAGE
  plan_->executing();
#endif
  const bool staged = requestStaging();
#ifdef LIBASSIMP_CPP_COVERAGE
  if (coverageBlockNextExecute.exchange(false)) {
    std::unique_lock<std::mutex> lock(coverageExecuteMutex);
    coverageExecuteBlocked.store(true);
    coverageExecuteCondition.wait(
        lock, [&] { return coverageExecuteReleased || cancelled(); });
    coverageExecuteBlocked.store(false);
  }
#endif
  libassimp::PlanStatus status = libassimp::PlanStatus::Aborted;
  if (!cancelled() && staged) {
    status = plan_->run(
        [this](const std::string &name, libassimp::Bytes &bytes) {
          return resolve(name, bytes);
        });
  } else if (!cancelled() && !plan_->cancelled())
    status = libassimp::PlanStatus::Failed;
  finish(status);
}

void Job::finish(libassimp::PlanStatus status) {
  bool environmentClosing;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    environmentClosing = environmentClosing_;
    request_.reset();
  }
  if (environmentClosing) {
    endPlan();
    abortThreadSafeFunction();
    return;
  }
  if (!dispatch(new Event{EventKind::Complete, shared_from_this(), {}, status},
                true))
    endPlan();
}

class Executor {
public:
  static Executor &instance() {
    static Executor executor;
    return executor;
  }

  void environmentOpened() {
    const std::lock_guard<std::mutex> lock(mutex_);
    ++environments_;
  }

  void environmentClosed() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (--environments_ != 0)
      return;
    stop(lock, true);
  }

  void submit(const std::shared_ptr<Job> &job) {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (!joining_ && !worker_.joinable())
      worker_ = std::thread([this] { loop(); });
    queue_.push_back(job);
    condition_.notify_one();
  }

  bool remove(const std::shared_ptr<Job> &job) {
    const std::lock_guard<std::mutex> lock(mutex_);
    const auto found = std::find(queue_.begin(), queue_.end(), job);
    if (found == queue_.end())
      return false;
    queue_.erase(found);
    return true;
  }

  std::pair<std::size_t, std::size_t> counts() const {
    const std::lock_guard<std::mutex> lock(mutex_);
    return {queue_.size(), active_ ? 1u : 0u};
  }

#ifdef LIBASSIMP_CPP_COVERAGE
  void stopForCoverage() {
    std::unique_lock<std::mutex> lock(mutex_);
    stop(lock, false);
  }
#endif

  ~Executor() {
    std::unique_lock<std::mutex> lock(mutex_);
    stop(lock, false);
  }

private:
  Executor() = default;

  void stop(std::unique_lock<std::mutex> &lock, bool environmentDriven) {
#ifdef LIBASSIMP_CPP_COVERAGE
    const bool waited = joining_;
    if (waited)
      ++coverageJoinWaiters;
#endif
    lifecycleCondition_.wait(lock, [&] { return !joining_; });
#ifdef LIBASSIMP_CPP_COVERAGE
    if (waited)
      --coverageJoinWaiters;
#endif
    if (environmentDriven && environments_ != 0)
      return;
    if (!worker_.joinable())
      return;
    joining_ = true;
    stopping_ = true;
    std::deque<std::shared_ptr<Job>> queued;
    queue_.swap(queued);
    const std::shared_ptr<Job> active = active_;
    lock.unlock();
    for (const std::shared_ptr<Job> &job : queued) {
      job->cancel(nullptr, true);
      job->finish(libassimp::PlanStatus::Aborted);
    }
    if (active)
      active->cancel(nullptr, true);
    condition_.notify_one();
    worker_.join();
#ifdef LIBASSIMP_CPP_COVERAGE
    if (coverageBlockNextJoin.exchange(false)) {
      std::unique_lock<std::mutex> coverageLock(coverageExecuteMutex);
      coverageJoinBlocked.store(true);
      coverageExecuteCondition.wait(coverageLock,
                                    [&] { return coverageJoinReleased; });
      coverageJoinBlocked.store(false);
    }
#endif
    lock.lock();
    stopping_ = false;
    joining_ = false;
    if (!queue_.empty())
      worker_ = std::thread([this] { loop(); });
    condition_.notify_one();
    lifecycleCondition_.notify_all();
  }

  void loop() {
    for (;;) {
      std::unique_lock<std::mutex> lock(mutex_);
      condition_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
      if (stopping_)
        return;
      auto job = queue_.front();
      queue_.pop_front();
      active_ = job;
      // Both execution and the final job release stay outside the executor lock.
      lock.unlock();
      job->execute();
      lock.lock();
      active_.reset();
      lock.unlock();
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::condition_variable lifecycleCondition_;
  std::deque<std::shared_ptr<Job>> queue_;
  std::shared_ptr<Job> active_;
  std::thread worker_;
  std::size_t environments_ = 0;
  bool stopping_ = false;
  bool joining_ = false;
};

void NativePlan::retainInputs(napi_env env, napi_value values,
                              std::size_t bytes) {
  napi_ref reference;
  napi_status status;
#ifdef LIBASSIMP_CPP_COVERAGE
  if (takeCoverageFailure(CoverageFailure::Reference))
    status = napi_generic_failure;
  else
#endif
    status = napi_create_reference(env, values, 1, &reference);
  if (status != napi_ok)
    throw Napi::Error::New(env, "could not retain native conversion inputs");
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    inputValues_ = reference;
    retainedBytes_ = bytes;
  }
#ifdef LIBASSIMP_CPP_COVERAGE
  coverageRetainedBytes.fetch_add(bytes);
#endif
}

void NativePlan::releaseInputs(napi_env env) {
  napi_ref reference;
  std::size_t bytes;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    reference = std::exchange(inputValues_, nullptr);
    bytes = std::exchange(retainedBytes_, 0);
  }
  if (reference == nullptr)
    return;
#ifdef LIBASSIMP_CPP_COVERAGE
  coverageRetainedBytes.fetch_sub(bytes);
#endif
  napi_delete_reference(env, reference);
}

void NativePlan::releaseIdleInputs(napi_env env) {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (busy_)
      return;
  }
  releaseInputs(env);
}

bool NativePlan::staged() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return plan_ != nullptr;
}

bool NativePlan::cancelled() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return cancelled_;
}

bool NativePlan::stage(napi_env env) {
  std::unique_lock<std::mutex> lock(mutex_);
  const napi_ref reference =
      cancelled_ || stagingFailed_ ? nullptr : inputValues_;

  bool succeeded = false;
  try {
    if (reference != nullptr) {
      napi_value values;
      std::uint32_t length;
      napi_status status;
#ifdef LIBASSIMP_CPP_COVERAGE
      if (takeCoverageFailure(CoverageFailure::StageReference))
        status = napi_generic_failure;
      else
#endif
        status = napi_get_reference_value(env, reference, &values);
      if (status != napi_ok)
        throw std::runtime_error("changed inputs");
#ifdef LIBASSIMP_CPP_COVERAGE
      if (takeCoverageFailure(CoverageFailure::StageLength))
        status = napi_generic_failure;
      else
#endif
        status = napi_get_array_length(env, values, &length);
      if (status != napi_ok || length != files_.size())
        throw std::runtime_error("changed inputs");
      std::vector<libassimp::NamedBytes> files;
      files.reserve(files_.size());
      for (std::uint32_t index = 0; index < length; ++index) {
        napi_value value;
        napi_typedarray_type type;
        std::size_t byteLength;
        void *data;
        napi_value arrayBuffer;
        std::size_t byteOffset;
#ifdef LIBASSIMP_CPP_COVERAGE
        if (takeCoverageFailure(CoverageFailure::StageElement))
          status = napi_generic_failure;
        else
#endif
          status = napi_get_element(env, values, index, &value);
        if (status != napi_ok)
          throw std::runtime_error("changed inputs");
#ifdef LIBASSIMP_CPP_COVERAGE
        if (takeCoverageFailure(CoverageFailure::StageTypedArray))
          status = napi_generic_failure;
        else
#endif
          status = napi_get_typedarray_info(env, value, &type, &byteLength,
                                            &data, &arrayBuffer, &byteOffset);
        if (status != napi_ok || byteLength != files_[index].length)
          throw std::runtime_error("changed inputs");
        (void)type;
        libassimp::Bytes bytes;
        if (byteLength != 0) {
          const auto *begin = static_cast<const std::uint8_t *>(data);
          bytes.assign(begin, begin + byteLength);
        }
        files.push_back({files_[index].name, std::move(bytes)});
      }
      auto plan = std::make_unique<libassimp::Plan>(
          std::move(entryName_), std::move(files), std::move(importProperties_),
          postProcess_, std::move(targets_), libassimp::Resolver{});
      plan_ = std::move(plan);
      succeeded = true;
#ifdef LIBASSIMP_CPP_COVERAGE
      stagedBytes_ = retainedBytes_;
      coverageStagedBytes.fetch_add(stagedBytes_);
#endif
    }
  } catch (...) {
    stagingFailed_ = true;
  }
  lock.unlock();
  releaseInputs(env);
  return succeeded;
}

libassimp::PlanStatus NativePlan::run(libassimp::Resolver resolve) {
  return plan_->run(std::move(resolve));
}

void NativePlan::cancel() {
  libassimp::Plan *plan;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    cancelled_ = true;
    plan = plan_.get();
  }
  if (plan)
    plan->cancel();
}

const libassimp::Result &NativePlan::result() const {
  if (plan_)
    return plan_->result();
  return stagingFailed_ ? stagingResult_ : emptyResult_;
}

std::size_t NativePlan::importAttempts() const {
  return plan_ ? plan_->importAttempts() : 0;
}

bool NativePlan::begin(const std::shared_ptr<Job> &job) {
  const std::lock_guard<std::mutex> lock(mutex_);
  if (busy_)
    return false;
  busy_ = true;
  activeJob_ = job;
  return true;
}

void NativePlan::end(const Job *job) {
#ifdef LIBASSIMP_CPP_COVERAGE
  const std::chrono::steady_clock::time_point finished =
      std::chrono::steady_clock::now();
#endif
  const std::lock_guard<std::mutex> lock(mutex_);
  if (activeJob_.lock().get() != job)
    return;
#ifdef LIBASSIMP_CPP_COVERAGE
  if (diagnosticsQueued_) {
    if (plan_)
      diagnostics_.phases = plan_->phaseDiagnostics();
    diagnostics_.total = finished - queuedAt_;
  } else {
    diagnostics_ = {};
  }
  diagnosticsQueued_ = false;
#endif
  activeJob_.reset();
  busy_ = false;
}

bool NativePlan::busy() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return busy_;
}

std::shared_ptr<Job> NativePlan::activeJob() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return activeJob_.lock();
}

#ifdef LIBASSIMP_CPP_COVERAGE
void NativePlan::queued() {
  const std::lock_guard<std::mutex> lock(mutex_);
  diagnostics_ = {};
  queuedAt_ = std::chrono::steady_clock::now();
  diagnosticsQueued_ = true;
}

void NativePlan::executing() {
  const std::lock_guard<std::mutex> lock(mutex_);
  diagnostics_.queueWait = std::chrono::steady_clock::now() - queuedAt_;
}

NativeDiagnostics NativePlan::diagnostics() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return diagnostics_;
}
#endif

std::uint64_t EnvironmentState::add(const std::shared_ptr<Job> &job) {
  const std::uint64_t id = nextJob++;
  jobs.emplace(id, job);
  return id;
}

void EnvironmentState::finishCleanupIfReady() {
  if (!closing || !cleanupWalked || !jobs.empty())
    return;
  napi_remove_async_cleanup_hook(std::exchange(cleanup, nullptr));
  delete this;
}

void EnvironmentState::remove(std::uint64_t id) {
  jobs.erase(id);
  finishCleanupIfReady();
}

struct ThreadSafeFinalizer {
  EnvironmentState *environment;
  std::uint64_t job;
};

void finalizeThreadSafeFunction(napi_env, void *data, void *) {
  std::unique_ptr<ThreadSafeFinalizer> finalizer(
      static_cast<ThreadSafeFinalizer *>(data));
  finalizer->environment->remove(finalizer->job);
}

libassimp::ResolveStatus resolveStatusFromJs(const Napi::CallbackInfo &info) {
  if (info.Length() == 0 || !info[0].IsNumber())
    throw Napi::TypeError::New(info.Env(), "resolver status must be 0, 1, 2, or 3");
  const double number = info[0].As<Napi::Number>().DoubleValue();
  const int status = info[0].As<Napi::Number>().Int32Value();
  if (number != status || status < 0 || status > 3)
    throw Napi::TypeError::New(info.Env(), "resolver status must be 0, 1, 2, or 3");
  return static_cast<libassimp::ResolveStatus>(status);
}

void callJavaScript(napi_env rawEnv, napi_value callback, void *, void *data) {
  std::unique_ptr<Event> event(static_cast<Event *>(data));
  if (rawEnv == nullptr) {
    if (event->kind == EventKind::Stage)
      event->job->stageClosed();
    else if (event->request)
      event->request->settle(libassimp::ResolveStatus::Aborted);
    else if (event->job)
      event->job->endPlan();
    return;
  }

  const Napi::Env env(rawEnv);
  if (event->kind == EventKind::Stage) {
    event->job->stage(rawEnv);
    return;
  }
  if (event->kind == EventKind::Complete) {
    napi_value status;
    napi_status created;
#ifdef LIBASSIMP_CPP_COVERAGE
    if (takeCoverageFailure(CoverageFailure::Complete))
      created = napi_generic_failure;
    else
#endif
      created =
          napi_create_int32(rawEnv, static_cast<int>(event->status), &status);
    if (created == napi_ok) {
      napi_resolve_deferred(rawEnv, event->job->deferred(), status);
    }
    event->job->endPlan();
    return;
  }

  event->job->setReferenced(rawEnv, false);
  const std::weak_ptr<ResolveRequest> weakRequest = event->request;
  const std::weak_ptr<Job> weakJob = event->job;
  try {
    const Napi::Function settle = Napi::Function::New(
        env, [weakRequest, weakJob](const Napi::CallbackInfo &info) {
          const std::shared_ptr<ResolveRequest> request = weakRequest.lock();
          if (!request)
            return Napi::Boolean::New(info.Env(), false);
          const libassimp::ResolveStatus status = resolveStatusFromJs(info);
          libassimp::Bytes bytes;
          if (status == libassimp::ResolveStatus::Found && info.Length() > 1 &&
              !info[1].IsUndefined() && !info[1].IsNull()) {
            bytes = bytesFromJs(info[1], "resolved bytes");
          }
          const bool accepted = request->settle(status, std::move(bytes));
          if (accepted) {
            weakJob.lock()->setReferenced(info.Env(), true);
          }
          return Napi::Boolean::New(info.Env(), accepted);
        });
    Napi::Function(rawEnv, callback)
        .Call({Napi::String::New(env, event->request->name), settle});
  } catch (...) {
    if (event->request->settle(libassimp::ResolveStatus::Failed))
      event->job->setReferenced(rawEnv, true);
  }
}

void cleanupEnvironment(napi_async_cleanup_hook_handle handle, void *data) {
  auto *environment = static_cast<EnvironmentState *>(data);
  environment->cleanup = handle;
  environment->closing = true;
  std::vector<std::shared_ptr<Job>> jobs;
  jobs.reserve(environment->jobs.size());
  for (const auto &entry : environment->jobs) {
    jobs.push_back(entry.second);
  }
  Executor &executor = Executor::instance();
  for (const std::shared_ptr<Job> &job : jobs) {
    job->cancel(environment->env, true);
    if (executor.remove(job))
      job->finish(libassimp::PlanStatus::Aborted);
  }
#ifdef LIBASSIMP_CPP_COVERAGE
  if (!environment->coverageClosed)
#endif
  executor.environmentClosed();
  environment->cleanupWalked = true;
  environment->finishCleanupIfReady();
}

PlanHandle *handleFromJs(const Napi::Value &value) {
  if (!value.IsExternal())
    throw Napi::TypeError::New(value.Env(),
                               "expected an opaque conversion plan");
  const Napi::External<PlanHandle> handle =
      value.As<Napi::External<PlanHandle>>();
  if (!handle.CheckTypeTag(&kPlanType)) {
    throw Napi::TypeError::New(value.Env(),
                               "expected an opaque conversion plan");
  }
  return handle.Data();
}

std::shared_ptr<NativePlan> planFromJs(const Napi::Value &value) {
  const std::shared_ptr<NativePlan> plan = handleFromJs(value)->plan;
  if (!plan)
    throw Napi::Error::New(value.Env(), "conversion plan is destroyed");
  return plan;
}

void requireIdle(const std::shared_ptr<NativePlan> &plan, Napi::Env env) {
  if (plan->busy())
    throw Napi::Error::New(env, "conversion plan is already running");
}

Napi::Value preparePlan(const Napi::CallbackInfo &info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 3)
    throw Napi::TypeError::New(env,
                               "preparePlan expects entryName, files, options");
  const Napi::Object options = objectAt(info[2], "options");
  const Napi::Value postProcess = options.Get("postProcess");
  if (!postProcess.IsNumber())
    throw Napi::TypeError::New(env, "options.postProcess must be a number");
  const double postProcessNumber = postProcess.As<Napi::Number>().DoubleValue();
  const std::uint32_t postProcessValue =
      postProcess.As<Napi::Number>().Uint32Value();
  if (postProcessNumber != postProcessValue) {
    throw Napi::TypeError::New(env, "options.postProcess must be a uint32");
  }

  ValidatedFiles files = validateFilesFromJs(info[1]);
  auto plan = std::make_shared<NativePlan>(
      stringAt(info[0], "entryName"), std::move(files.files),
      propertiesFromJs(options.Get("importProperties")), postProcessValue,
      targetsFromJs(options.Get("targets")));
  plan->retainInputs(env, files.values, files.bytes);
  try {
#ifdef LIBASSIMP_CPP_COVERAGE
    if (takeCoverageFailure(CoverageFailure::External))
      throw Napi::Error::New(env, "could not create native conversion handle");
#endif
    auto planHandle = std::make_unique<PlanHandle>(PlanHandle{plan});
    Napi::External<PlanHandle> handle = Napi::External<PlanHandle>::New(
        env, planHandle.get(), [](Napi::Env env, PlanHandle *handle) {
          if (handle->plan)
            handle->plan->releaseIdleInputs(env);
          delete handle;
        });
    planHandle.release();
    handle.TypeTag(&kPlanType);
    return handle;
  } catch (...) {
    plan->releaseInputs(env);
    throw;
  }
}

Napi::Value runPlan(const Napi::CallbackInfo &info) {
  const Napi::Env env = info.Env();
  if (info.Length() == 0)
    throw Napi::TypeError::New(env, "runPlan expects a plan and resolveRequest");
  if (info.Length() != 2 || !info[1].IsFunction())
    throw Napi::TypeError::New(env, "resolveRequest must be a function");
  std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  auto job = std::make_shared<Job>(plan);
  if (!plan->begin(job))
    throw Napi::Error::New(env, "conversion plan is already running");

  try {
    napi_deferred deferred;
    napi_value promise;
    napi_status promiseStatus;
#ifdef LIBASSIMP_CPP_COVERAGE
    if (takeCoverageFailure(CoverageFailure::Promise))
      promiseStatus = napi_generic_failure;
    else
#endif
      promiseStatus = napi_create_promise(env, &deferred, &promise);
    if (promiseStatus != napi_ok)
      throw Napi::Error::New(env, "could not create runPlan promise");
    job->setDeferred(deferred);

    auto *environment = static_cast<EnvironmentState *>(info.Data());
    auto finalizer = std::make_unique<ThreadSafeFinalizer>(
        ThreadSafeFinalizer{environment, 0});
    const std::uint64_t id = environment->add(job);
    finalizer->job = id;
    napi_value resourceName;
    napi_threadsafe_function function;
    napi_status status;
#ifdef LIBASSIMP_CPP_COVERAGE
    if (takeCoverageFailure(CoverageFailure::ThreadSafeFunction))
      status = napi_generic_failure;
    else
#endif
      status = napi_create_string_utf8(
          env, "libassimp:runPlan", NAPI_AUTO_LENGTH, &resourceName);
    if (status == napi_ok) {
      status = napi_create_threadsafe_function(
          env, info[1], nullptr, resourceName, 0, 1, finalizer.get(),
          finalizeThreadSafeFunction, nullptr, callJavaScript, &function);
    }
    if (status != napi_ok) {
      environment->remove(id);
      throw Napi::Error::New(
          env, "could not create runPlan thread-safe function");
    }
    finalizer.release();
    job->setThreadSafeFunction(function);
#ifdef LIBASSIMP_CPP_COVERAGE
    plan->queued();
#endif
    try {
#ifdef LIBASSIMP_CPP_COVERAGE
      if (takeCoverageFailure(CoverageFailure::Submit))
        throw std::runtime_error("coverage submit failure");
      if (takeCoverageFailure(CoverageFailure::UnknownSubmit))
        throw 1;
#endif
      Executor::instance().submit(job);
    } catch (const std::exception &error) {
      job->cancel(env, true);
      job->finish(libassimp::PlanStatus::Aborted);
      throw Napi::Error::New(env, error.what());
    } catch (...) {
      job->cancel(env, true);
      job->finish(libassimp::PlanStatus::Aborted);
      throw Napi::Error::New(env, "could not submit native conversion");
    }
    return Napi::Promise(env, promise);
  } catch (...) {
    plan->end(job.get());
    throw;
  }
}

Napi::Value cancelPlan(const Napi::CallbackInfo &info) {
  if (info.Length() != 1)
    throw Napi::TypeError::New(info.Env(), "cancelPlan expects a plan");
  const std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  const std::shared_ptr<Job> job = plan->activeJob();
  if (!job) {
    plan->cancel();
    plan->releaseInputs(info.Env());
    return info.Env().Undefined();
  }
  job->cancel(info.Env(), false);
  if (Executor::instance().remove(job))
    job->finish(libassimp::PlanStatus::Aborted);
  return info.Env().Undefined();
}

Napi::Object resultToJs(Napi::Env env, const libassimp::Result &result) {
  Napi::Object output = Napi::Object::New(env);
  output.Set("ok", result.ok);
  output.Set("code", result.code);
  output.Set("message", result.message);
  if (result.formatIndex >= 0)
    output.Set("formatIndex", result.formatIndex);
  if (!result.format.empty())
    output.Set("format", result.format);
  Napi::Array formats = Napi::Array::New(env, result.formats.size());
  for (std::size_t formatIndex = 0; formatIndex < result.formats.size();
       ++formatIndex) {
    const libassimp::ConvertedFormat &converted = result.formats[formatIndex];
    Napi::Object format = Napi::Object::New(env);
    format.Set("format", converted.format);
    Napi::Array files = Napi::Array::New(env, converted.files.size());
    for (std::size_t fileIndex = 0; fileIndex < converted.files.size();
         ++fileIndex) {
      const libassimp::NamedBytes &convertedFile = converted.files[fileIndex];
      Napi::Object file = Napi::Object::New(env);
      file.Set("name", convertedFile.name);
      Napi::Uint8Array bytes =
          Napi::Uint8Array::New(env, convertedFile.bytes.size());
      std::copy(convertedFile.bytes.begin(), convertedFile.bytes.end(),
                bytes.Data());
      file.Set("bytes", bytes);
      files.Set(fileIndex, file);
    }
    format.Set("files", files);
    formats.Set(formatIndex, format);
  }
  output.Set("formats", formats);
  return output;
}

Napi::Value takePlanResult(const Napi::CallbackInfo &info) {
  if (info.Length() != 1)
    throw Napi::TypeError::New(info.Env(), "takePlanResult expects a plan");
  const std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  requireIdle(plan, info.Env());
  return resultToJs(info.Env(), plan->result());
}

Napi::Value destroyPlan(const Napi::CallbackInfo &info) {
  if (info.Length() != 1)
    throw Napi::TypeError::New(info.Env(), "destroyPlan expects a plan");
  PlanHandle *handle = handleFromJs(info[0]);
  if (handle->plan) {
    handle->plan->releaseIdleInputs(info.Env());
    handle->plan.reset();
  }
  return info.Env().Undefined();
}

Napi::Array formatsToJs(Napi::Env env,
                        const std::vector<libassimp::FormatInfo> &values) {
  Napi::Array formats = Napi::Array::New(env, values.size());
  for (std::size_t index = 0; index < values.size(); ++index) {
    Napi::Object format = Napi::Object::New(env);
    format.Set("id", values[index].id);
    format.Set("extension", values[index].extension);
    format.Set("description", values[index].description);
    formats.Set(index, format);
  }
  return formats;
}

struct Inventories {
  std::vector<libassimp::FormatInfo> imports = libassimp::importFormats();
  std::vector<libassimp::FormatInfo> exports = libassimp::exportFormats();
};

const Inventories &inventories() {
  static const Inventories values;
  return values;
}

Napi::Value importFormats(const Napi::CallbackInfo &info) {
  return formatsToJs(info.Env(), inventories().imports);
}

Napi::Value exportFormats(const Napi::CallbackInfo &info) {
  return formatsToJs(info.Env(), inventories().exports);
}

#ifdef LIBASSIMP_CPP_COVERAGE
Napi::Value coverageWrongPlan(const Napi::CallbackInfo &info) {
  return Napi::External<PlanHandle>::New(info.Env(), nullptr);
}

Napi::Value coverageEmptyResult(const Napi::CallbackInfo &info) {
  libassimp::Result result;
  result.ok = true;
  result.formats.push_back({"empty", {{"empty.bin", {}}}});
  return resultToJs(info.Env(), result);
}

Napi::Value coverageStats(const Napi::CallbackInfo &info) {
  const auto [queued, active] = Executor::instance().counts();
  Napi::Object stats = Napi::Object::New(info.Env());
  stats.Set("queuedJobs", Napi::Number::New(info.Env(), queued));
  stats.Set("activeJobs", Napi::Number::New(info.Env(), active));
  stats.Set("outstandingRequests",
            Napi::Number::New(info.Env(), coverageOutstandingRequests.load()));
  stats.Set("transientBytes",
            Napi::Number::New(info.Env(), coverageTransientBytes.load()));
  stats.Set("retainedBytes",
            Napi::Number::New(info.Env(), coverageRetainedBytes.load()));
  stats.Set("stagedBytes",
            Napi::Number::New(info.Env(), coverageStagedBytes.load()));
  stats.Set("joinWaiters",
            Napi::Number::New(info.Env(), coverageJoinWaiters.load()));
  if (info.Length() == 1) {
    const std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
    stats.Set("importAttempts",
              Napi::Number::New(info.Env(), plan->importAttempts()));
    const NativeDiagnostics diagnostics = plan->diagnostics();
    Napi::Object timings = Napi::Object::New(info.Env());
    timings.Set("queueWaitMs",
                Napi::Number::New(info.Env(), milliseconds(diagnostics.queueWait)));
    timings.Set("resolverWaitMs",
                Napi::Number::New(info.Env(), milliseconds(diagnostics.phases.resolverWait)));
    timings.Set("importMs",
                Napi::Number::New(info.Env(), milliseconds(diagnostics.phases.phases[0])));
    timings.Set("postProcessMs",
                Napi::Number::New(info.Env(), milliseconds(diagnostics.phases.phases[1])));
    timings.Set("exportMs",
                Napi::Number::New(info.Env(), milliseconds(diagnostics.phases.phases[2])));
    timings.Set("totalMs",
                Napi::Number::New(info.Env(), milliseconds(diagnostics.total)));
    timings.Set("importObserved",
                Napi::Boolean::New(info.Env(), diagnostics.phases.observed[0]));
    timings.Set("postProcessObserved",
                Napi::Boolean::New(info.Env(), diagnostics.phases.observed[1]));
    timings.Set("exportObserved",
                Napi::Boolean::New(info.Env(), diagnostics.phases.observed[2]));
    stats.Set("timings", timings);
  }
  return stats;
}

Napi::Value coverageBlockExecution(const Napi::CallbackInfo &info) {
  {
    const std::lock_guard<std::mutex> lock(coverageExecuteMutex);
    coverageExecuteReleased = false;
  }
  coverageBlockNextExecute.store(true);
  return info.Env().Undefined();
}

Napi::Value coverageExecutionBlocked(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), coverageExecuteBlocked.load());
}

Napi::Value coverageReleaseExecution(const Napi::CallbackInfo &info) {
  {
    const std::lock_guard<std::mutex> lock(coverageExecuteMutex);
    coverageExecuteReleased = true;
  }
  coverageExecuteCondition.notify_one();
  return info.Env().Undefined();
}

Napi::Value coverageStopExecutor(const Napi::CallbackInfo &info) {
  Executor::instance().stopForCoverage();
  return info.Env().Undefined();
}

Napi::Value coverageBlockJoin(const Napi::CallbackInfo &info) {
  {
    const std::lock_guard<std::mutex> lock(coverageExecuteMutex);
    coverageJoinReleased = false;
  }
  coverageBlockNextJoin.store(true);
  return info.Env().Undefined();
}

Napi::Value coverageJoinIsBlocked(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), coverageJoinBlocked.load());
}

Napi::Value coverageReleaseJoin(const Napi::CallbackInfo &info) {
  {
    const std::lock_guard<std::mutex> lock(coverageExecuteMutex);
    coverageJoinReleased = true;
  }
  coverageExecuteCondition.notify_one();
  return info.Env().Undefined();
}

Napi::Value coverageCloseEnvironment(const Napi::CallbackInfo &info) {
  auto *environment = static_cast<EnvironmentState *>(info.Data());
  environment->coverageClosed = true;
  Executor::instance().environmentClosed();
  return info.Env().Undefined();
}

Napi::Value coverageBlockResolve(const Napi::CallbackInfo &info) {
  {
    const std::lock_guard<std::mutex> lock(coverageExecuteMutex);
    coverageResolveReleased = false;
  }
  coverageBlockNextResolve.store(true);
  return info.Env().Undefined();
}

Napi::Value coverageResolveIsBlocked(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), coverageResolveBlocked.load());
}

Napi::Value coverageReleaseResolve(const Napi::CallbackInfo &info) {
  {
    const std::lock_guard<std::mutex> lock(coverageExecuteMutex);
    coverageResolveReleased = true;
  }
  coverageExecuteCondition.notify_one();
  return info.Env().Undefined();
}

Napi::Value coverageCloseDispatch(const Napi::CallbackInfo &info) {
  coverageCloseNextDispatch.store(true);
  return info.Env().Undefined();
}

Napi::Value coverageCloseStageDispatch(const Napi::CallbackInfo &info) {
  coverageCloseNextStageDispatch.store(true);
  return info.Env().Undefined();
}

Napi::Value coverageClosePlan(const Napi::CallbackInfo &info) {
  planFromJs(info[0])->activeJob()->closeForCoverage(info.Env());
  return info.Env().Undefined();
}

Napi::Value coverageRollbackPlan(const Napi::CallbackInfo &info) {
  planFromJs(info[0])->end(nullptr);
  return info.Env().Undefined();
}

Napi::Value coverageFailNext(const Napi::CallbackInfo &info) {
  coverageFailure.store(info[0].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

Napi::Value coverageDrainCallbacks(const Napi::CallbackInfo &info) {
  auto request = std::make_shared<ResolveRequest>("coverage.sidecar");
  callJavaScript(nullptr, nullptr, nullptr,
                 new Event{EventKind::Resolve, {}, request});
  const std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  callJavaScript(nullptr, nullptr, nullptr,
                 new Event{EventKind::Stage, std::make_shared<Job>(plan), {}});
  auto job = std::make_shared<Job>(plan);
  plan->begin(job);
  callJavaScript(nullptr, nullptr, nullptr,
                 new Event{EventKind::Complete, job, {}});
  callJavaScript(nullptr, nullptr, nullptr,
                 new Event{EventKind::Complete, {}, {}});
  return info.Env().Undefined();
}

Napi::Value coverageCleanupGuard(const Napi::CallbackInfo &info) {
  auto *environment = static_cast<EnvironmentState *>(info.Data());
  environment->closing = true;
  environment->finishCleanupIfReady();
  environment->closing = false;
  return info.Env().Undefined();
}

Napi::Value coverageBlockProgress(const Napi::CallbackInfo &info) {
  libassimp::detail::blockNextProgress(
      static_cast<libassimp::ProgressPhase>(
          info[0].As<Napi::Number>().Int32Value()));
  return info.Env().Undefined();
}

Napi::Value coverageProgressBlocked(const Napi::CallbackInfo &info) {
  return Napi::Number::New(
      info.Env(), static_cast<int>(libassimp::detail::progressBlocked()));
}

Napi::Value coverageReleaseProgress(const Napi::CallbackInfo &info) {
  libassimp::detail::releaseProgress();
  return info.Env().Undefined();
}
#endif

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  (void)inventories();
  auto *environment = new EnvironmentState{env};
  napi_status cleanupStatus;
#ifdef LIBASSIMP_CPP_COVERAGE
  if (std::getenv("LIBASSIMP_COVERAGE_FAIL_CLEANUP") != nullptr)
    cleanupStatus = napi_generic_failure;
  else
#endif
    cleanupStatus = napi_add_async_cleanup_hook(
        env, cleanupEnvironment, environment, &environment->cleanup);
  if (cleanupStatus != napi_ok) {
    delete environment;
    throw Napi::Error::New(env, "could not register native cleanup");
  }
  Executor::instance().environmentOpened();
  exports.Set("buildIdentity", LIBASSIMP_NATIVE_BUILD_IDENTITY);
  exports.Set("napiVersion", NAPI_VERSION);
  exports.Set("packageVersion", LIBASSIMP_PACKAGE_VERSION);
  exports.Set("preparePlan", Napi::Function::New(env, preparePlan));
  exports.Set("runPlan",
              Napi::Function::New(env, runPlan, "runPlan", environment));
  exports.Set("cancelPlan", Napi::Function::New(env, cancelPlan));
  exports.Set("takePlanResult", Napi::Function::New(env, takePlanResult));
  exports.Set("destroyPlan", Napi::Function::New(env, destroyPlan));
  exports.Set("importFormats", Napi::Function::New(env, importFormats));
  exports.Set("exportFormats", Napi::Function::New(env, exportFormats));
#ifdef LIBASSIMP_CPP_COVERAGE
  exports.Set("_coverageWrongPlan", Napi::Function::New(env, coverageWrongPlan));
  exports.Set("_coverageEmptyResult", Napi::Function::New(env, coverageEmptyResult));
  exports.Set("_coverageStats", Napi::Function::New(env, coverageStats));
  exports.Set("_coverageBlockNextExecute",
              Napi::Function::New(env, coverageBlockExecution));
  exports.Set("_coverageExecuteBlocked",
              Napi::Function::New(env, coverageExecutionBlocked));
  exports.Set("_coverageReleaseExecute",
              Napi::Function::New(env, coverageReleaseExecution));
  exports.Set("_coverageStopExecutor",
              Napi::Function::New(env, coverageStopExecutor));
  exports.Set("_coverageBlockNextJoin",
              Napi::Function::New(env, coverageBlockJoin));
  exports.Set("_coverageJoinBlocked",
              Napi::Function::New(env, coverageJoinIsBlocked));
  exports.Set("_coverageReleaseJoin",
              Napi::Function::New(env, coverageReleaseJoin));
  exports.Set("_coverageCloseEnvironment",
              Napi::Function::New(env, coverageCloseEnvironment,
                                  "coverageCloseEnvironment", environment));
  exports.Set("_coverageBlockNextResolve",
              Napi::Function::New(env, coverageBlockResolve));
  exports.Set("_coverageResolveBlocked",
              Napi::Function::New(env, coverageResolveIsBlocked));
  exports.Set("_coverageReleaseResolve",
              Napi::Function::New(env, coverageReleaseResolve));
  exports.Set("_coverageCloseNextDispatch",
              Napi::Function::New(env, coverageCloseDispatch));
  exports.Set("_coverageCloseNextStageDispatch",
              Napi::Function::New(env, coverageCloseStageDispatch));
  exports.Set("_coverageClosePlan",
              Napi::Function::New(env, coverageClosePlan));
  exports.Set("_coverageRollbackPlan",
              Napi::Function::New(env, coverageRollbackPlan));
  exports.Set("_coverageFailNext",
              Napi::Function::New(env, coverageFailNext));
  exports.Set("_coverageDrainCallbacks",
              Napi::Function::New(env, coverageDrainCallbacks));
  exports.Set("_coverageCleanupGuard",
              Napi::Function::New(env, coverageCleanupGuard,
                                  "coverageCleanupGuard", environment));
  exports.Set("_coverageBlockNextProgress",
              Napi::Function::New(env, coverageBlockProgress));
  exports.Set("_coverageProgressBlocked",
              Napi::Function::New(env, coverageProgressBlocked));
  exports.Set("_coverageReleaseProgress",
              Napi::Function::New(env, coverageReleaseProgress));
#endif
  return exports;
}

} // namespace

NODE_API_MODULE(libassimp, initialize)
