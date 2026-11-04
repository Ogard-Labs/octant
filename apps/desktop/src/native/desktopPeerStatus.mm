#include "desktopApplicationIdentity.h"
#import <AppKit/AppKit.h>
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <atomic>
#include <bsm/libbsm.h>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <crt_externs.h>
#include <cstring>
#include <fcntl.h>
#include <limits.h>
#include <mach/mach.h>
#include <map>
#include <memory>
#include <mutex>
#ifndef OCTANT_PEER_TRANSPORT_TEST
#include <node_api.h>
#endif
#include <servers/bootstrap.h>
#include <string>
#include <sys/event.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace {
using namespace octant::desktop_application;
constexpr auto operation_bound = std::chrono::milliseconds(2500);
constexpr uint32_t wire_magic = 0x4f435450;
constexpr mach_msg_id_t request_id = 0x4f435401, reply_id = 0x4f435402;
struct Result {
  std::string kind = "refused", reason = "native-unavailable", version;
};
struct Scope {
  audit_token_t token{};
  uid_t euid = 0, auid = 0;
  au_asid_t session = 0;
};
struct Identity : ArtifactIdentity { Scope scope; };
struct StatusMessage {
  mach_msg_header_t header{};
  uint32_t magic = wire_magic, protocol = 1, status = 0;
  char version[64]{};
};
union Received {
  mach_msg_header_t header;
  unsigned char bytes[1024];
};
struct State {
  std::atomic<bool> stopping = false, finished = true;
  std::mutex lock;
  mach_port_t receive = MACH_PORT_NULL;
  std::thread worker;
  ~State() {
    if (worker.joinable())
      worker.detach();
  }
};
std::shared_ptr<State> state = std::make_shared<State>();
std::atomic<bool> start_pending = false, status_pending = false,
                  close_pending = false, launch_pending = false;
std::atomic<unsigned> validations = 0, launches = 0;

bool read_scope(Scope &scope) {
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  if (task_info(mach_task_self(), TASK_AUDIT_TOKEN,
                reinterpret_cast<task_info_t>(&scope.token),
                &count) != KERN_SUCCESS)
    return false;
  scope.euid = audit_token_to_euid(scope.token);
  scope.auid = audit_token_to_auid(scope.token);
  scope.session = audit_token_to_asid(scope.token);
  return scope.euid == geteuid() && scope.auid != static_cast<uid_t>(-1) &&
         scope.session != static_cast<au_asid_t>(-1);
}
bool same_scope(audit_token_t token, const Scope &self) {
  return audit_token_to_euid(token) == self.euid &&
         audit_token_to_auid(token) == self.auid &&
         audit_token_to_asid(token) == self.session;
}
bool ordinary_self(bool stable) {
  const int count = *_NSGetArgc();
  char **args = *_NSGetArgv();
  if (count < 1 || count > 4)
    return false;
  std::array<std::string_view, 3> entries;
  for (int index = 1; index < count; ++index)
    entries[index - 1] = args[index];
  return octant::desktop_peer::ordinary_desktop_arguments(
      stable, {entries.data(), static_cast<size_t>(count - 1)});
}

bool validate_identity(audit_token_t token, const Scope &scope, bool stable,
                       const std::string &required_team, Identity &identity,
                       Deadline deadline, std::string &reason) {
  if (expired(deadline)) {
    reason = "deadline-exceeded";
    return false;
  }
  if (!same_scope(token, scope)) {
    reason = "invalid-scope";
    return false;
  }
  OwnedCF<CFDataRef> audit;
  audit.value = CFDataCreate(nullptr, reinterpret_cast<const UInt8 *>(&token),
                             sizeof(token));
  if (!audit.value)
    return false;
  const void *keys[] = {kSecGuestAttributeAudit}, *values[] = {audit.value};
  OwnedCF<CFDictionaryRef> attributes;
  attributes.value = CFDictionaryCreate(nullptr, keys, values, 1,
                                        &kCFTypeDictionaryKeyCallBacks,
                                        &kCFTypeDictionaryValueCallBacks);
  OwnedCF<SecCodeRef> dynamic;
  if (!attributes.value || SecCodeCopyGuestWithAttributes(
                               nullptr, attributes.value, kSecCSDefaultFlags,
                               &dynamic.value) != errSecSuccess) {
    reason = "invalid-peer";
    return false;
  }
  OwnedCF<SecStaticCodeRef> disk;
  if (SecCodeCopyStaticCode(dynamic.value, kSecCSDefaultFlags, &disk.value) !=
      errSecSuccess)
    return false;
  if (!validate_artifact(disk.value, dynamic.value, stable, required_team,
                         identity, deadline, reason))
    return false;
  identity.scope = scope;
  return true;
}

bool self_identity(bool stable, Identity &identity, Deadline deadline,
                   std::string &reason) {
  Scope scope;
  if (!read_scope(scope)) {
    reason = "invalid-scope";
    return false;
  }
  if (!validate_identity(scope.token, scope, stable, "", identity, deadline,
                         reason))
    return false;
  if (!ordinary_self(stable)) {
    reason = "invalid-peer";
    return false;
  }
  return true;
}
std::string endpoint(const Scope &scope) {
  return "app.octant.desktop.status.v1." + std::to_string(scope.euid) + "." +
         std::to_string(scope.session);
}
bool audit_from(const Received &received, audit_token_t &token) {
  const auto size = received.header.msgh_size;
  if (size < sizeof(mach_msg_header_t) || size > sizeof(received))
    return false;
  size_t offset = (static_cast<size_t>(size) + 3) & ~size_t(3);
  if (offset + sizeof(mach_msg_audit_trailer_t) > sizeof(received))
    return false;
  const auto *trailer = reinterpret_cast<const mach_msg_audit_trailer_t *>(
      received.bytes + offset);
  if (trailer->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 ||
      trailer->msgh_trailer_size < sizeof(*trailer))
    return false;
  token = trailer->msgh_audit;
  return true;
}
kern_return_t receive(mach_port_t port, Received &buffer,
                      unsigned milliseconds) {
  std::memset(&buffer, 0, sizeof(buffer));
  return mach_msg(&buffer.header,
                  MACH_RCV_MSG | MACH_RCV_TIMEOUT |
                      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                  0, sizeof(buffer), port, milliseconds, MACH_PORT_NULL);
}
void release_received(Received &received) {
  mach_msg_destroy(&received.header);
}
void stop(const std::shared_ptr<State> &owned) {
  owned->stopping = true;
  std::lock_guard guard(owned->lock);
  if (owned->receive != MACH_PORT_NULL) {
    mach_port_destroy(mach_task_self(), owned->receive);
    owned->receive = MACH_PORT_NULL;
  }
}
void serve(std::shared_ptr<State> owned, Identity self, mach_port_t port) {
  while (!owned->stopping) {
    Received received{};
    auto code = receive(port, received, 100);
    // Without MACH_RCV_LARGE, the kernel discards an oversized message and
    // destroys its rights. It must not let an untrusted sender end the owner.
    if (code == MACH_RCV_TIMED_OUT || code == MACH_RCV_TOO_LARGE)
      continue;
    if (code != KERN_SUCCESS)
      break;
    if (received.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) {
      release_received(received);
      continue;
    }
    audit_token_t token{};
    bool shape = received.header.msgh_size == sizeof(StatusMessage) &&
                 received.header.msgh_id == request_id &&
                 audit_from(received, token);
    auto *message = reinterpret_cast<StatusMessage *>(&received);
    if (!shape || message->magic != wire_magic || message->protocol != 1 ||
        message->status != 0 ||
        received.header.msgh_remote_port == MACH_PORT_NULL ||
        MACH_MSGH_BITS_REMOTE(received.header.msgh_bits) !=
            MACH_MSG_TYPE_PORT_SEND_ONCE) {
      release_received(received);
      continue;
    }
    Identity peer;
    std::string reason;
    const auto deadline = Clock::now() + operation_bound;
    ++validations;
    bool accepted = false;
    try {
      accepted = validate_identity(token, self.scope, false, self.team, peer,
                                   deadline, reason);
    } catch (...) {
      reason = "native-unavailable";
    }
    --validations;
    if (!owned->stopping && !expired(deadline)) {
      StatusMessage reply;
      reply.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MOVE_SEND_ONCE, 0);
      reply.header.msgh_size = sizeof(reply);
      reply.header.msgh_remote_port = received.header.msgh_remote_port;
      reply.header.msgh_id = reply_id;
      reply.status = accepted ? 1 : 2;
      if (accepted)
        std::memcpy(reply.version, self.version.c_str(),
                    self.version.size() + 1);
      // Ownership moves to the outgoing message before sending. On failure,
      // destroy the kernel-returned message rather than a copied stale name.
      received.header.msgh_remote_port = MACH_PORT_NULL;
      auto sent =
          mach_msg(&reply.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                   sizeof(reply), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
      if (sent != KERN_SUCCESS)
        mach_msg_destroy(&reply.header);
    }
    release_received(received);
  }
  stop(owned);
  owned->finished = true;
}
Result start_status(Deadline deadline) {
  Result result;
  Identity self;
  if (!self_identity(true, self, deadline, result.reason))
    return result;
  if (state->stopping)
    return {"refused", "deadline-exceeded", {}};
  std::lock_guard guard(state->lock);
  if (state->receive != MACH_PORT_NULL)
    return {"started", {}, {}};
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) !=
      KERN_SUCCESS)
    return result;
  mach_port_limits_t limits{4};
  if (mach_port_set_attributes(mach_task_self(), port, MACH_PORT_LIMITS_INFO,
                               reinterpret_cast<mach_port_info_t>(&limits),
                               MACH_PORT_LIMITS_INFO_COUNT) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), port, port,
                             MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS ||
      bootstrap_register(bootstrap_port, endpoint(self.scope).data(), port) !=
          KERN_SUCCESS) {
    mach_port_destroy(mach_task_self(), port);
    return result;
  }
  if (state->stopping || expired(deadline)) {
    mach_port_destroy(mach_task_self(), port);
    return {"refused", "deadline-exceeded", {}};
  }
  state->receive = port;
  state->finished = false;
  try {
    state->worker = std::thread(serve, state, self, port);
  } catch (...) {
    state->receive = MACH_PORT_NULL;
    state->finished = true;
    mach_port_destroy(mach_task_self(), port);
    return result;
  }
  return {"started", {}, {}};
}
Result query_status(Deadline deadline) {
  Result result;
  Identity self;
  if (!self_identity(false, self, deadline, result.reason))
    return result;
  if (state->stopping)
    return {"refused", "deadline-exceeded", {}};
  mach_port_t server = MACH_PORT_NULL, reply = MACH_PORT_NULL;
  const auto lookup =
      bootstrap_look_up(bootstrap_port, endpoint(self.scope).c_str(), &server);
  if (lookup != KERN_SUCCESS)
    return {"refused",
            lookup == BOOTSTRAP_UNKNOWN_SERVICE ? "not-running"
                                                : "native-unavailable",
            {}};
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply) !=
      KERN_SUCCESS) {
    mach_port_deallocate(mach_task_self(), server);
    return result;
  }
  StatusMessage request;
  request.header.msgh_bits =
      MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  request.header.msgh_size = sizeof(request);
  request.header.msgh_remote_port = server;
  request.header.msgh_local_port = reply;
  request.header.msgh_id = request_id;
  auto code = mach_msg(&request.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                       sizeof(request), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  if (code == KERN_SUCCESS) {
    Received received{};
    const auto before_receive = Clock::now();
    unsigned remaining =
        before_receive >= deadline
            ? 1
            : static_cast<unsigned>(std::max<int64_t>(
                  1, std::chrono::duration_cast<std::chrono::milliseconds>(
                         deadline - before_receive)
                         .count()));
    code = receive(reply, received, remaining);
    if (code == KERN_SUCCESS) {
      audit_token_t token{};
      auto *message = reinterpret_cast<StatusMessage *>(&received);
      if (!(received.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) &&
          received.header.msgh_size == sizeof(StatusMessage) &&
          received.header.msgh_id == reply_id && message->magic == wire_magic &&
          message->protocol == 1 && audit_from(received, token)) {
        Identity peer;
        if (validate_identity(token, self.scope, true, self.team, peer,
                              deadline, result.reason)) {
          if (message->status == 1 &&
              std::memchr(message->version, 0, sizeof(message->version)) &&
              std::string(message->version) == peer.version)
            result = {"ready", {}, peer.version};
          else
            result = {"refused", "invalid-peer", {}};
        }
      }
      release_received(received);
    }
  }
  mach_port_destroy(mach_task_self(), reply);
  mach_port_deallocate(mach_task_self(), server);
  if (expired(deadline) || code == MACH_RCV_TIMED_OUT)
    result = {"refused", "deadline-exceeded", {}};
  return result;
}
struct PendingLaunch {
  std::mutex lock;
  std::condition_variable changed;
  bool finished = false, accepted = false;
  PendingLaunch() { ++launches; }
};
void finish_launch(const std::shared_ptr<PendingLaunch> &launch,
                   bool accepted) {
  std::lock_guard guard(launch->lock);
  if (launch->finished)
    return;
  launch->accepted = accepted;
  launch->finished = true;
  --launches;
  launch->changed.notify_all();
}

Result launch_stable_host(Deadline deadline) {
  Result result;
  Identity self;
  if (!self_identity(false, self, deadline, result.reason))
    return result;
  if (state->stopping)
    return {"refused", "deadline-exceeded", {}};
  @autoreleasepool {
    NSURL *candidate = [NSWorkspace.sharedWorkspace
        URLForApplicationWithBundleIdentifier:@"app.octant.desktop"];
    if (!candidate)
      return {"refused", "not-installed", {}};
    OwnedCF<SecStaticCodeRef> disk;
    if (SecStaticCodeCreateWithPath((__bridge CFURLRef)candidate,
                                    kSecCSDefaultFlags,
                                    &disk.value) != errSecSuccess)
      return result;
    Identity installed;
    if (!validate_artifact(disk.value, nullptr, true, self.team, installed,
                           deadline, result.reason))
      return result;
    OwnedCF<CFDictionaryRef> info;
    if (!signed_info(disk.value, info))
      return result;
    const auto raw_plist = field(info.value, kSecCodeInfoPList);
    if (!raw_plist || CFGetTypeID(raw_plist) != CFDictionaryGetTypeID() ||
        text(field(static_cast<CFDictionaryRef>(raw_plist),
                   CFSTR("OctantHostLaunchPolicy"))) != "host-only-v1")
      return {"refused", "incompatible-host", {}};
    // Open the validated primary bundle URL, never a command found on PATH.
    NSURL *url = [NSURL
        fileURLWithPath:[NSString stringWithUTF8String:installed.root.c_str()]
            isDirectory:YES];
    auto launch = std::make_shared<PendingLaunch>();
    dispatch_async(dispatch_get_main_queue(), ^{
      if (expired(deadline) || state->stopping) {
        finish_launch(launch, false);
        return;
      }
      NSWorkspaceOpenConfiguration *configuration =
          [NSWorkspaceOpenConfiguration configuration];
      configuration.activates = NO;
      configuration.addsToRecentItems = NO;
      configuration.promptsUserIfNeeded = NO;
      configuration.createsNewApplicationInstance = NO;
      configuration.allowsRunningApplicationSubstitution = NO;
      configuration.arguments = @[ @"--octant-host-only" ];
      [NSWorkspace.sharedWorkspace
          openApplicationAtURL:url
                 configuration:configuration
             completionHandler:^(NSRunningApplication *application,
                                 NSError *error) {
               finish_launch(launch, application != nil && error == nil &&
                                         !expired(deadline) &&
                                         !state->stopping);
             }];
    });
    std::unique_lock guard(launch->lock);
    launch->changed.wait_until(guard, deadline,
                               [&] { return launch->finished; });
    if (expired(deadline))
      return {"refused", "deadline-exceeded", {}};
    return launch->accepted ? Result{"started", {}, {}} : result;
  }
}

Result close_status(Deadline deadline) {
  stop(state);
  while (
      (!state->finished || validations.load() != 0 || launches.load() != 0) &&
      !expired(deadline))
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (!state->finished || validations.load() != 0 || launches.load() != 0)
    return {"failed", "deadline-exceeded", {}};
  std::lock_guard guard(state->lock);
  if (state->worker.joinable())
    state->worker.join();
  return {"closed", {}, {}};
}
// The standalone test build exercises the same receive/disposal loop only;
// it does not expose a policy bypass in the addon.
#ifndef OCTANT_PEER_TRANSPORT_TEST
struct Work {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string operation;
  Result result;
  Deadline deadline;
  bool executed = false;
};
void execute(napi_env, void *data) {
  auto &job = *static_cast<Work *>(data);
  job.executed = true;
  try {
    if (job.operation == "start")
      job.result = start_status(job.deadline);
    else if (job.operation == "status")
      job.result = query_status(job.deadline);
    else if (job.operation == "launchStableHost")
      job.result = launch_stable_host(job.deadline);
    else
      job.result = close_status(job.deadline);
  } catch (...) {
    job.result = {job.operation == "close" ? "failed" : "refused",
                  "native-unavailable",
                  {}};
  }
  if (job.operation != "close")
    --validations;
}
void set(napi_env env, napi_value object, const char *key,
         const std::string &text) {
  napi_value value;
  napi_create_string_utf8(env, text.data(), text.size(), &value);
  napi_set_named_property(env, object, key, value);
}
#include "desktopPeerWindows.h"
void complete(napi_env env, napi_status, void *data) {
  std::unique_ptr<Work> job(static_cast<Work *>(data));
  if (!job->executed && job->operation != "close")
    --validations;
  napi_value value;
  napi_create_object(env, &value);
  set(env, value, "kind", job->result.kind);
  if (!job->result.reason.empty())
    set(env, value, "reason", job->result.reason);
  if (job->result.kind == "ready") {
    set(env, value, "version", job->result.version);
    napi_value protocol;
    napi_create_uint32(env, 1, &protocol);
    napi_set_named_property(env, value, "protocol", protocol);
  }
  napi_resolve_deferred(env, job->deferred, value);
  napi_delete_async_work(env, job->work);
  if (job->operation == "start")
    start_pending = false;
  if (job->operation == "status")
    status_pending = false;
  if (job->operation == "launchStableHost")
    launch_pending = false;
  if (job->operation == "close")
    close_pending = false;
}
napi_value operation(napi_env env, napi_callback_info info) {
  void *raw = nullptr;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, nullptr, nullptr, &raw);
  const char *name = static_cast<const char *>(raw);
  auto job = std::make_unique<Work>();
  job->operation = name;
  job->deadline = Clock::now() + operation_bound;
  napi_value promise;
  napi_create_promise(env, &job->deferred, &promise);
  bool busy = !pthread_main_np() || argc != 0;
  if (!busy)
    busy = (job->operation == "start" && start_pending.exchange(true)) ||
           (job->operation == "status" && status_pending.exchange(true)) ||
           (job->operation == "launchStableHost" &&
            launch_pending.exchange(true)) ||
           (job->operation == "close" && close_pending.exchange(true));
  if (busy) {
    job->result = {"refused", "native-unavailable", {}};
    napi_value value;
    napi_create_object(env, &value);
    set(env, value, "kind", job->result.kind);
    set(env, value, "reason", job->result.reason);
    napi_resolve_deferred(env, job->deferred, value);
    return promise;
  }
  if (job->operation == "close")
    stop(state);
  if (job->operation != "close")
    ++validations;
  napi_value resource;
  napi_create_string_utf8(env, "desktop-peer-status", NAPI_AUTO_LENGTH,
                          &resource);
  if (napi_create_async_work(env, nullptr, resource, execute, complete,
                             job.get(), &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    if (job->operation != "close")
      --validations;
    if (job->operation == "start")
      start_pending = false;
    if (job->operation == "status")
      status_pending = false;
    if (job->operation == "launchStableHost")
      launch_pending = false;
    if (job->operation == "close")
      close_pending = false;
    if (job->work)
      napi_delete_async_work(env, job->work);
    napi_value value;
    napi_create_object(env, &value);
    set(env, value, "kind", job->operation == "close" ? "failed" : "refused");
    set(env, value, "reason", "native-unavailable");
    napi_resolve_deferred(env, job->deferred, value);
    return promise;
  }
  job.release();
  return promise;
}
napi_value initialize(napi_env env, napi_value exports) {
  install_window_exports(env, exports);
  for (const char *name : {"start", "status", "launchStableHost", "close"}) {
    napi_value function;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, operation,
                         const_cast<char *>(name), &function);
    napi_set_named_property(env, exports, name, function);
  }
  if (pthread_main_np())
    napi_add_env_cleanup_hook(
        env,
        [](void *) {
          stop_windows();
          {
            std::lock_guard guard(window_state->lock);
            if (window_state->callback) {
              napi_release_threadsafe_function(window_state->callback,
                                               napi_tsfn_abort);
              window_state->callback = nullptr;
            }
            if (window_state->worker.joinable()) {
              if (window_state->finished)
                window_state->worker.join();
              else
                window_state->worker.detach();
            }
          }
          stop(state);
          std::lock_guard guard(state->lock);
          if (state->worker.joinable()) {
            if (state->finished)
              state->worker.join();
            else
              state->worker.detach();
          }
        },
        nullptr);
  return exports;
}
#endif
} // namespace
#ifndef OCTANT_PEER_TRANSPORT_TEST
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
#endif
