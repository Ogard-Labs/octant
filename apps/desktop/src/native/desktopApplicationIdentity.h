#pragma once
#include "desktopPeerPolicy.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <array>
#include <chrono>
#include <fcntl.h>
#include <limits.h>
#include <string>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

// Static signed-artifact validation is shared; peer audit/role admission stays
// in desktopPeerStatus and is never replaced by a disk signature.
namespace octant::desktop_application {
using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
inline constexpr const char *stable_id = "app.octant.desktop",
                            *nightly_id = "app.octant.desktop.nightly";
struct ArtifactIdentity { std::string team, version, root; };
inline bool expired(Deadline deadline) { return Clock::now() >= deadline; }
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
inline std::string text(CFTypeRef value) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID())
    return {};
  char buffer[PATH_MAX]{};
  if (!CFStringGetCString(static_cast<CFStringRef>(value), buffer,
                          sizeof(buffer), kCFStringEncodingUTF8))
    return {};
  return buffer;
}
inline CFTypeRef field(CFDictionaryRef object, CFStringRef key) {
  return object ? CFDictionaryGetValue(object, key) : nullptr;
}
inline bool flag(CFDictionaryRef object, CFStringRef key) {
  return field(object, key) == kCFBooleanTrue;
}
inline bool same_file(const struct stat &a, const struct stat &b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino &&
         a.st_size == b.st_size &&
         a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
         a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec;
}
inline bool fuse_artifact(const std::string &root, Deadline deadline) {
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
inline bool signed_info(SecStaticCodeRef code, OwnedCF<CFDictionaryRef> &info) {
  return SecCodeCopySigningInformation(const_cast<SecCodeRef>(code),
                                       kSecCSSigningInformation,
                                       &info.value) == errSecSuccess;
}
inline bool validate_artifact(SecStaticCodeRef disk, SecCodeRef dynamic, bool stable,
                       const std::string &required_team, ArtifactIdentity &identity,
                       Deadline deadline, std::string &reason) {
  OwnedCF<CFDictionaryRef> info;
  if (!signed_info(dynamic ? dynamic : disk, info))
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
      (dynamic && SecCodeCheckValidity(dynamic, kSecCSDefaultFlags,
                                       requirement.value) != errSecSuccess)) {
    reason = "invalid-peer";
    return false;
  }
  if (expired(deadline)) {
    reason = "deadline-exceeded";
    return false;
  }
  if (SecStaticCodeCheckValidity(disk,
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
  if (!signed_info(disk, verified_info) ||
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
  // Running peers additionally bind this artifact to the kernel guest. Both
  // paths recheck resources after reading the fixed-entry fuse policy.
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
      (dynamic && SecCodeCheckValidity(dynamic, kSecCSDefaultFlags,
                                       requirement.value) != errSecSuccess)) {
    reason = "invalid-peer";
    return false;
  }
  if (expired(deadline)) {
    reason = "deadline-exceeded";
    return false;
  }
  identity.team = team;
  identity.root = root;
  identity.version = text(field(plist, CFSTR("CFBundleShortVersionString")));
  if (identity.version.empty() || identity.version.size() >= 64) {
    reason = "incompatible-host";
    return false;
  }
  return true;
}

} // namespace octant::desktop_application
