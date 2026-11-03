#include "desktopPeerPolicy.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <atomic>
#include <bsm/libbsm.h>
#include <chrono>
#include <crt_externs.h>
#include <cstring>
#include <fcntl.h>
#include <limits.h>
#include <mach/mach.h>
#include <memory>
#include <mutex>
#include <node_api.h>
#include <servers/bootstrap.h>
#include <string>
#include <sys/mount.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace {
using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
constexpr auto operation_bound = std::chrono::milliseconds(2500);
constexpr uint32_t wire_magic = 0x4f435450;
constexpr mach_msg_id_t request_id = 0x4f435401, reply_id = 0x4f435402;
constexpr const char *stable_id = "app.octant.desktop",
                     *nightly_id = "app.octant.desktop.nightly";
struct Result {
  std::string kind = "refused", reason = "native-unavailable", version;
};
template <class T> struct OwnedCF {
  T value = nullptr;
  ~OwnedCF() {
    if (value)
      CFRelease(value);
  }
  OwnedCF() = default;
  OwnedCF(const OwnedCF &) = delete;
  OwnedCF &operator=(const OwnedCF &) = delete;
};
struct Scope {
  audit_token_t token{};
  uid_t euid = 0, auid = 0;
  au_asid_t session = 0;
};
struct Identity {
  std::string team, version;
  Scope scope;
};
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
                  close_pending = false;
std::atomic<unsigned> validations = 0;

bool expired(Deadline deadline) { return Clock::now() >= deadline; }
std::string text(CFTypeRef value) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID())
    return {};
  char buffer[PATH_MAX]{};
  if (!CFStringGetCString(static_cast<CFStringRef>(value), buffer,
                          sizeof(buffer), kCFStringEncodingUTF8))
    return {};
  return buffer;
}
CFTypeRef field(CFDictionaryRef object, CFStringRef key) {
  return object ? CFDictionaryGetValue(object, key) : nullptr;
}
bool flag(CFDictionaryRef object, CFStringRef key) {
  return field(object, key) == kCFBooleanTrue;
}
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
  const std::string scheme = stable ? "octant://" : "octant-nightly://";
  bool psn = false, link = false;
  const int count = *_NSGetArgc();
  char **args = *_NSGetArgv();
  if (count > 4)
    return false;
  for (int index = 1; index < count; ++index) {
    std::string_view arg(args[index]);
    if (arg.size() > 16384)
      return false;
    if (!psn && arg.starts_with("-psn_")) {
      psn = true;
      continue;
    }
    if (!link && arg.starts_with(scheme)) {
      link = true;
      continue;
    }
    return false;
  }
  return true;
}
bool same_file(const struct stat &a, const struct stat &b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino &&
         a.st_size == b.st_size &&
         a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
         a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec;
}
bool fuse_artifact(const std::string &root, Deadline deadline) {
  const std::string directory =
      root + "/Contents/Frameworks/Electron Framework.framework/";
  char canonical[PATH_MAX]{};
  if (!realpath((directory + "Electron Framework").c_str(), canonical))
    return false;
  if (!std::string_view(canonical).starts_with(directory + "Versions/"))
    return false;
  int fd = open(canonical, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0)
    return false;
  struct stat before{}, after{};
  if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_size <= 0 || before.st_size > 512 * 1024 * 1024) {
    close(fd);
    return false;
  }
  octant::desktop_peer::FuseArtifactScan scan;
  std::array<uint8_t, 64 * 1024> bytes{};
  off_t offset = 0;
  bool valid = true;
  while (offset < before.st_size && !expired(deadline)) {
    size_t length = static_cast<size_t>(
        std::min<off_t>(bytes.size(), before.st_size - offset));
    ssize_t count = pread(fd, bytes.data(), length, offset);
    if (count <= 0) {
      valid = false;
      break;
    }
    scan.feed({bytes.data(), static_cast<size_t>(count)});
    offset += count;
  }
  valid = valid && offset == before.st_size && fstat(fd, &after) == 0 &&
          same_file(before, after) && !expired(deadline) &&
          scan.finish() == octant::desktop_peer::FusePolicy::trusted;
  close(fd);
  return valid;
}
bool signed_info(SecStaticCodeRef code, OwnedCF<CFDictionaryRef> &info) {
  return SecCodeCopySigningInformation(const_cast<SecCodeRef>(code),
                                       kSecCSSigningInformation,
                                       &info.value) == errSecSuccess;
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
  OwnedCF<CFDictionaryRef> info;
  if (!signed_info(dynamic.value, info))
    return false;
  const std::string identifier = stable ? stable_id : nightly_id;
  const std::string product = stable ? "Octant" : "Octant Nightly";
  const std::string team = text(field(info.value, kSecCodeInfoTeamIdentifier));
  uint32_t flags = 0;
  CFTypeRef raw_flags = field(info.value, kSecCodeInfoFlags);
  if (!raw_flags || CFGetTypeID(raw_flags) != CFNumberGetTypeID() ||
      !CFNumberGetValue(static_cast<CFNumberRef>(raw_flags),
                        kCFNumberSInt32Type, &flags))
    return false;
  if ((flags & kSecCodeSignatureAdhoc) || !(flags & kSecCodeSignatureRuntime) ||
      team.size() != 10 ||
      team.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") !=
          std::string::npos) {
    reason = "unsigned-build";
    return false;
  }
  if (text(field(info.value, kSecCodeInfoIdentifier)) != identifier ||
      (!required_team.empty() && team != required_team)) {
    reason = "invalid-peer";
    return false;
  }
  const std::string requirement_text =
      "anchor apple generic and identifier \"" + identifier +
      "\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
      "certificate leaf[subject.OU] = \"" +
      team + "\"";
  OwnedCF<CFStringRef> requirement_string;
  requirement_string.value = CFStringCreateWithCString(
      nullptr, requirement_text.c_str(), kCFStringEncodingUTF8);
  OwnedCF<SecRequirementRef> requirement;
  if (!requirement_string.value ||
      SecRequirementCreateWithString(requirement_string.value,
                                     kSecCSDefaultFlags,
                                     &requirement.value) != errSecSuccess ||
      SecCodeCheckValidity(dynamic.value, kSecCSDefaultFlags,
                           requirement.value) != errSecSuccess) {
    reason = "invalid-peer";
    return false;
  }
  if (expired(deadline)) {
    reason = "deadline-exceeded";
    return false;
  }
  OwnedCF<SecStaticCodeRef> disk;
  if (SecCodeCopyStaticCode(dynamic.value, kSecCSDefaultFlags, &disk.value) !=
          errSecSuccess ||
      SecStaticCodeCheckValidity(disk.value,
                                 kSecCSStrictValidate |
                                     kSecCSCheckAllArchitectures |
                                     kSecCSCheckNestedCode,
                                 requirement.value) != errSecSuccess) {
    reason = "invalid-peer";
    return false;
  }
  if (expired(deadline)) {
    reason = "deadline-exceeded";
    return false;
  }
  // Candidate signing data forms the requirement only. Consume filesystem
  // metadata after validity, as SecCodeCopySigningInformation requires.
  OwnedCF<CFDictionaryRef> verified_info;
  if (!signed_info(disk.value, verified_info) ||
      text(field(verified_info.value, kSecCodeInfoIdentifier)) != identifier ||
      text(field(verified_info.value, kSecCodeInfoTeamIdentifier)) != team ||
      !field(verified_info.value, kSecCodeInfoFlags) ||
      !CFEqual(raw_flags, field(verified_info.value, kSecCodeInfoFlags))) {
    reason = "invalid-peer";
    return false;
  }
  const auto raw_entitlements =
      field(verified_info.value, kSecCodeInfoEntitlementsDict);
  if (raw_entitlements) {
    if (CFGetTypeID(raw_entitlements) != CFDictionaryGetTypeID()) {
      reason = "invalid-peer";
      return false;
    }
    const auto entitlements = static_cast<CFDictionaryRef>(raw_entitlements);
    if (flag(entitlements,
             CFSTR("com.apple.security.cs.disable-library-validation")) ||
        flag(entitlements,
             CFSTR("com.apple.security.cs.allow-dyld-environment-variables")) ||
        flag(entitlements, CFSTR("com.apple.security.get-task-allow"))) {
      reason = "invalid-peer";
      return false;
    }
  }
  const auto raw_executable =
      field(verified_info.value, kSecCodeInfoMainExecutable);
  if (!raw_executable || CFGetTypeID(raw_executable) != CFURLGetTypeID())
    return false;
  char executable[PATH_MAX]{};
  if (!CFURLGetFileSystemRepresentation(
          static_cast<CFURLRef>(raw_executable), true,
          reinterpret_cast<UInt8 *>(executable), sizeof(executable)))
    return false;
  std::string path(executable), suffix = "/Contents/MacOS/" + product;
  if (!path.ends_with(suffix)) {
    reason = "invalid-peer";
    return false;
  }
  std::string root = path.substr(0, path.size() - suffix.size());
  struct statfs volume{};
  if (!root.ends_with(".app") || statfs(root.c_str(), &volume) != 0 ||
      !(volume.f_flags & MNT_LOCAL)) {
    reason = "incompatible-host";
    return false;
  }
  const auto raw_plist = field(verified_info.value, kSecCodeInfoPList);
  if (!raw_plist || CFGetTypeID(raw_plist) != CFDictionaryGetTypeID())
    return false;
  const auto plist = static_cast<CFDictionaryRef>(raw_plist);
  if (text(field(plist, CFSTR("CFBundleIdentifier"))) != identifier ||
      text(field(plist, CFSTR("CFBundleExecutable"))) != product ||
      text(field(plist, CFSTR("OctantDesktopEntryPolicy"))) !=
          "sealed-main-v1") {
    reason = "incompatible-host";
    return false;
  }
  const auto raw_integrity = field(plist, CFSTR("ElectronAsarIntegrity"));
  if (!raw_integrity || CFGetTypeID(raw_integrity) != CFDictionaryGetTypeID()) {
    reason = "incompatible-host";
    return false;
  }
  const auto raw_archive = field(static_cast<CFDictionaryRef>(raw_integrity),
                                 CFSTR("Resources/app.asar"));
  if (!raw_archive || CFGetTypeID(raw_archive) != CFDictionaryGetTypeID()) {
    reason = "incompatible-host";
    return false;
  }
  const auto archive = static_cast<CFDictionaryRef>(raw_archive);
  if (text(field(archive, CFSTR("algorithm"))) != "SHA256" ||
      text(field(archive, CFSTR("hash"))).size() != 64 ||
      !fuse_artifact(root, deadline)) {
    reason = expired(deadline) ? "deadline-exceeded" : "incompatible-host";
    return false;
  }
  // Dynamic validation binds this on-disk signature to the kernel's running
  // guest. A fresh static object rechecks resources after the fuse read.
  OwnedCF<CFURLRef> root_url;
  root_url.value = CFURLCreateFromFileSystemRepresentation(
      nullptr, reinterpret_cast<const UInt8 *>(root.data()), root.size(), true);
  OwnedCF<SecStaticCodeRef> fresh;
  if (!root_url.value ||
      SecStaticCodeCreateWithPath(root_url.value, kSecCSDefaultFlags,
                                  &fresh.value) != errSecSuccess)
    return false;
  if (SecStaticCodeCheckValidity(fresh.value,
                                 kSecCSStrictValidate |
                                     kSecCSCheckAllArchitectures |
                                     kSecCSCheckNestedCode,
                                 requirement.value) != errSecSuccess) {
    reason = "invalid-peer";
    return false;
  }
  OwnedCF<CFDictionaryRef> fresh_info;
  if (!signed_info(fresh.value, fresh_info))
    return false;
  const auto original_hash = field(verified_info.value, kSecCodeInfoUnique),
             fresh_hash = field(fresh_info.value, kSecCodeInfoUnique);
  const auto fresh_plist = field(fresh_info.value, kSecCodeInfoPList);
  if (!original_hash || !fresh_hash ||
      CFGetTypeID(original_hash) != CFDataGetTypeID() ||
      CFGetTypeID(fresh_hash) != CFDataGetTypeID() ||
      !CFEqual(original_hash, fresh_hash) || !fresh_plist ||
      CFGetTypeID(fresh_plist) != CFDictionaryGetTypeID() ||
      !CFEqual(plist, fresh_plist) ||
      SecCodeCheckValidity(dynamic.value, kSecCSDefaultFlags,
                           requirement.value) != errSecSuccess) {
    reason = "invalid-peer";
    return false;
  }
  if (expired(deadline)) {
    reason = "deadline-exceeded";
    return false;
  }
  identity.team = team;
  identity.scope = scope;
  identity.version = text(field(plist, CFSTR("CFBundleShortVersionString")));
  if (identity.version.empty() || identity.version.size() >= 64) {
    reason = "incompatible-host";
    return false;
  }
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
Result close_status(Deadline deadline) {
  stop(state);
  while ((!state->finished || validations.load() != 0) && !expired(deadline))
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (!state->finished || validations.load() != 0)
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
  for (const char *name : {"start", "status", "close"}) {
    napi_value function;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, operation,
                         const_cast<char *>(name), &function);
    napi_set_named_property(env, exports, name, function);
  }
  if (pthread_main_np())
    napi_add_env_cleanup_hook(
        env,
        [](void *) {
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
