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
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
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

using Replies =
    std::unordered_map<std::string, std::optional<libassimp::Bytes>>;
constexpr napi_type_tag kPlanType{0xbff5b876d76342c3ULL, 0xa44fd1210e0915d1ULL};
std::mutex assimpMutex;

#ifdef LIBASSIMP_CPP_COVERAGE
std::atomic<bool> coverageFailNextExecute{false};
std::atomic<bool> coverageBlockNextExecute{false};
std::atomic<bool> coverageExecuteBlocked{false};
std::mutex coverageExecuteMutex;
std::condition_variable coverageExecuteCondition;
bool coverageExecuteReleased = false;
#endif

libassimp::Bytes bytesFromJs(const Napi::Value &value, const char *path) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(value.Env(),
                               std::string(path) + " must be a Uint8Array");
  }
  const Napi::Uint8Array bytes = value.As<Napi::Uint8Array>();
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

std::vector<libassimp::NamedBytes> filesFromJs(const Napi::Value &value) {
  const Napi::Array values = arrayAt(value, "files");
  std::vector<libassimp::NamedBytes> files;
  files.reserve(values.Length());
  for (std::uint32_t index = 0; index < values.Length(); ++index) {
    const Napi::Object file = objectAt(values.Get(index), "file");
    files.push_back({stringAt(file.Get("name"), "file.name"),
                     bytesFromJs(file.Get("bytes"), "file.bytes")});
  }
  return files;
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

class NativePlan {
public:
  NativePlan(std::string entryName, std::vector<libassimp::NamedBytes> files,
             libassimp::Properties importProperties, unsigned int postProcess,
             std::vector<libassimp::Target> targets)
      : plan_(std::move(entryName), std::move(files),
              std::move(importProperties), postProcess, std::move(targets),
              [this](const std::string &name, libassimp::Bytes &output) {
                const auto found = replies_.find(name);
                if (found == replies_.end()) {
                  pendingName_ = name;
                  return libassimp::ResolveStatus::Pending;
                }
                if (!found->second.has_value())
                  return libassimp::ResolveStatus::Missing;
                output = *found->second;
                return libassimp::ResolveStatus::Found;
              }) {}

  libassimp::PlanStatus run() {
    pendingName_.clear();
    return plan_.run();
  }

  void supply(const std::string &name, std::optional<libassimp::Bytes> bytes) {
    if (pendingName_.empty() || name != pendingName_) {
      throw std::runtime_error(
          "supplyPlan name does not match the pending request");
    }
    replies_[name] = std::move(bytes);
  }

  const std::string &pendingName() const { return pendingName_; }
  const libassimp::Result &result() const { return plan_.result(); }
  bool busy() const { return busy_.load(); }
  bool begin() { return !busy_.exchange(true); }
  void end() { busy_.store(false); }

private:
  Replies replies_;
  std::string pendingName_;
  std::atomic<bool> busy_{false};
  libassimp::Plan plan_;
};

struct PlanHandle {
  std::shared_ptr<NativePlan> plan;
};

class RunWorker;

struct DispatchTicket {
  Napi::ThreadSafeFunction signal;
  RunWorker *worker = nullptr;
};

void dispatchTicket(const std::shared_ptr<DispatchTicket> &ticket);

class RunDispatcher {
public:
  bool submit(const std::shared_ptr<DispatchTicket> &ticket) {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (active_) {
      waiting_.push_back(ticket);
      return false;
    }
    active_ = ticket;
    return true;
  }

  void finish() {
    std::shared_ptr<DispatchTicket> next;
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      active_.reset();
      if (!waiting_.empty()) {
        next = waiting_.front();
        waiting_.pop_front();
        active_ = next;
      }
    }
    if (next)
      dispatchTicket(next);
  }

  void abandon(const std::shared_ptr<DispatchTicket> &ticket) {
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      const auto found = std::find(waiting_.begin(), waiting_.end(), ticket);
      if (found != waiting_.end()) {
        waiting_.erase(found);
        return;
      }
    }
    finish();
  }

private:
  std::mutex mutex_;
  std::shared_ptr<DispatchTicket> active_;
  std::deque<std::shared_ptr<DispatchTicket>> waiting_;
};

RunDispatcher &runDispatcher() {
  static RunDispatcher dispatcher;
  return dispatcher;
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

  auto plan = std::make_shared<NativePlan>(
      stringAt(info[0], "entryName"), filesFromJs(info[1]),
      propertiesFromJs(options.Get("importProperties")), postProcessValue,
      targetsFromJs(options.Get("targets")));
  Napi::External<PlanHandle> handle = Napi::External<PlanHandle>::New(
      env, new PlanHandle{std::move(plan)}, [](Napi::Env, PlanHandle *handle) {
        delete handle;
      });
  handle.TypeTag(&kPlanType);
  return handle;
}

#ifdef LIBASSIMP_CPP_COVERAGE
bool coverageFailNextQueue = false;
#endif

class RunWorker final : public Napi::AsyncWorker {
public:
  RunWorker(Napi::Env env, std::shared_ptr<NativePlan> plan,
            std::shared_ptr<DispatchTicket> ticket)
      : Napi::AsyncWorker(env, "libassimp:runPlan"),
        deferred_(Napi::Promise::Deferred::New(env)), plan_(std::move(plan)),
        ticket_(std::move(ticket)) {}

  Napi::Promise promise() const { return deferred_.Promise(); }
  const std::shared_ptr<DispatchTicket> &ticket() const { return ticket_; }

  void queue() {
#ifdef LIBASSIMP_CPP_COVERAGE
    if (std::exchange(coverageFailNextQueue, false))
      throw Napi::Error::New(Env(), "coverage queue failure");
#endif
    Queue();
  }

  void abandon() { plan_->end(); }

  void rejectQueue(const Napi::Error &error) {
    plan_->end();
    deferred_.Reject(error.Value());
    runDispatcher().finish();
  }

  void Execute() override {
#ifdef LIBASSIMP_CPP_COVERAGE
    if (coverageFailNextExecute.exchange(false))
      throw std::runtime_error("coverage execution failure");
    if (coverageBlockNextExecute.exchange(false)) {
      std::unique_lock<std::mutex> lock(coverageExecuteMutex);
      coverageExecuteBlocked.store(true);
      coverageExecuteCondition.wait(
          lock, [] { return coverageExecuteReleased; });
      coverageExecuteBlocked.store(false);
    }
#endif
    const std::lock_guard<std::mutex> lock(assimpMutex);
    status_ = plan_->run();
  }

  void OnOK() override {
    deferred_.Resolve(Napi::Number::New(Env(), static_cast<int>(status_)));
  }

  void OnError(const Napi::Error &error) override {
    deferred_.Reject(error.Value());
  }

  void OnWorkComplete(Napi::Env env, napi_status status) override {
    try {
      Napi::AsyncWorker::OnWorkComplete(env, status);
    } catch (const Napi::Error &) {
      // Worker termination can disable JavaScript before native work completes.
      Destroy();
    }
  }

protected:
  void Destroy() override {
    plan_->end();
    runDispatcher().finish();
    Napi::AsyncWorker::Destroy();
  }

private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<NativePlan> plan_;
  std::shared_ptr<DispatchTicket> ticket_;
  libassimp::PlanStatus status_ = libassimp::PlanStatus::Failed;
};

void queueDispatched(Napi::Env env, DispatchTicket *dispatched) {
  RunWorker *worker = std::exchange(dispatched->worker, nullptr);
  if (!worker)
    return;
  if (env == nullptr) {
    worker->abandon();
    runDispatcher().abandon(worker->ticket());
    delete worker;
    return;
  }
  try {
    worker->queue();
  } catch (const Napi::Error &error) {
    worker->rejectQueue(error);
    delete worker;
  }
}

void dispatchTicket(const std::shared_ptr<DispatchTicket> &ticket) {
  ticket->signal.NonBlockingCall(
      ticket.get(), [](Napi::Env env, Napi::Function,
                       DispatchTicket *dispatched) {
        queueDispatched(env, dispatched);
      });
  ticket->signal.Release();
}

void finalizeDispatchTicket(Napi::Env,
                            std::shared_ptr<DispatchTicket> *holder, void *) {
  std::shared_ptr<DispatchTicket> ticket = std::move(*holder);
  delete holder;
  RunWorker *worker = std::exchange(ticket->worker, nullptr);
  if (!worker)
    return;
  runDispatcher().abandon(ticket);
  worker->abandon();
  delete worker;
}

Napi::Value runPlan(const Napi::CallbackInfo &info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 1)
    throw Napi::TypeError::New(env, "runPlan expects a plan");
  std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  auto ticket = std::make_shared<DispatchTicket>();
  auto worker = std::make_unique<RunWorker>(env, plan, ticket);
  auto holder = std::make_unique<std::shared_ptr<DispatchTicket>>(ticket);
  ticket->signal = Napi::ThreadSafeFunction::New(
      env, env.Global().Get("Boolean").As<Napi::Function>(),
      "libassimp:dispatch", 0, 1, static_cast<void *>(nullptr),
      finalizeDispatchTicket, holder.get());
  holder.release();
  if (!plan->begin()) {
    ticket->signal.Release();
    throw Napi::Error::New(env, "conversion plan is already running");
  }
  ticket->worker = worker.get();
  const Napi::Promise promise = worker->promise();
  if (!runDispatcher().submit(ticket)) {
    worker.release();
    return promise;
  }
  ticket->worker = nullptr;
  try {
    worker->queue();
  } catch (...) {
    runDispatcher().finish();
    plan->end();
    ticket->signal.Release();
    throw;
  }
  worker.release();
  ticket->signal.Release();
  return promise;
}

Napi::Value pendingName(const Napi::CallbackInfo &info) {
  if (info.Length() != 1)
    throw Napi::TypeError::New(info.Env(), "pendingName expects a plan");
  const std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  requireIdle(plan, info.Env());
  return plan->pendingName().empty()
             ? info.Env().Undefined()
             : Napi::String::New(info.Env(), plan->pendingName());
}

Napi::Value supplyPlan(const Napi::CallbackInfo &info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 2 && info.Length() != 3) {
    throw Napi::TypeError::New(env, "supplyPlan expects plan, [name,] bytes");
  }
  const std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  requireIdle(plan, env);
  const bool named = info.Length() == 3;
  const std::string name =
      named ? stringAt(info[1], "name") : plan->pendingName();
  const Napi::Value value = info[named ? 2 : 1];
  std::optional<libassimp::Bytes> bytes;
  if (!value.IsUndefined() && !value.IsNull())
    bytes = bytesFromJs(value, "bytes");
  try {
    plan->supply(name, std::move(bytes));
  } catch (const std::exception &error) {
    throw Napi::Error::New(env, error.what());
  }
  return env.Undefined();
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

Napi::Value coverageQueueFailure(const Napi::CallbackInfo &info) {
  coverageFailNextQueue = true;
  return runPlan(info);
}

Napi::Value coverageExecutionFailure(const Napi::CallbackInfo &info) {
  coverageFailNextExecute.store(true);
  return runPlan(info);
}

Napi::Value coverageDispatchCleanup(const Napi::CallbackInfo &info) {
  std::shared_ptr<NativePlan> plan = planFromJs(info[0]);
  auto ticket = std::make_shared<DispatchTicket>();
  auto *worker = new RunWorker(info.Env(), plan, ticket);
  plan->begin();
  ticket->worker = worker;
  runDispatcher().submit(ticket);
  queueDispatched(Napi::Env(nullptr), ticket.get());
  queueDispatched(Napi::Env(nullptr), ticket.get());
  return info.Env().Undefined();
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
#endif

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  std::vector<libassimp::FormatInfo> importFormats;
  std::vector<libassimp::FormatInfo> exportFormats;
  {
    const std::lock_guard<std::mutex> lock(assimpMutex);
    importFormats = libassimp::importFormats();
    exportFormats = libassimp::exportFormats();
  }
  exports.Set("buildIdentity", LIBASSIMP_NATIVE_BUILD_IDENTITY);
  exports.Set("napiVersion", NAPI_VERSION);
  exports.Set("packageVersion", LIBASSIMP_PACKAGE_VERSION);
  exports.Set("preparePlan", Napi::Function::New(env, preparePlan));
  exports.Set("runPlan", Napi::Function::New(env, runPlan));
  exports.Set("pendingName", Napi::Function::New(env, pendingName));
  exports.Set("supplyPlan", Napi::Function::New(env, supplyPlan));
  exports.Set("takePlanResult", Napi::Function::New(env, takePlanResult));
  exports.Set("destroyPlan", Napi::Function::New(env, destroyPlan));
  exports.Set("importFormats", formatsToJs(env, importFormats));
  exports.Set("exportFormats", formatsToJs(env, exportFormats));
#ifdef LIBASSIMP_CPP_COVERAGE
  exports.Set("_coverageWrongPlan", Napi::Function::New(env, coverageWrongPlan));
  exports.Set("_coverageEmptyResult", Napi::Function::New(env, coverageEmptyResult));
  exports.Set("_coverageQueueFailure", Napi::Function::New(env, coverageQueueFailure));
  exports.Set("_coverageExecutionFailure",
              Napi::Function::New(env, coverageExecutionFailure));
  exports.Set("_coverageDispatchCleanup",
              Napi::Function::New(env, coverageDispatchCleanup));
  exports.Set("_coverageBlockNextExecute",
              Napi::Function::New(env, coverageBlockExecution));
  exports.Set("_coverageExecuteBlocked",
              Napi::Function::New(env, coverageExecutionBlocked));
  exports.Set("_coverageReleaseExecute",
              Napi::Function::New(env, coverageReleaseExecution));
#endif
  return exports;
}

} // namespace

NODE_API_MODULE(libassimp, initialize)
