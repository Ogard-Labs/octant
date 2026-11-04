#include "desktopApplicationIdentity.h"
#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <map>
#include <mach-o/loader.h>
#include <memory>
#include <crt_externs.h>
#include <dirent.h>
#include <dispatch/dispatch.h>
#include <mutex>
#include <set>
#include <vector>
#ifndef OCTANT_INSTALLATION_TEST
#include <node_api.h>
#endif

// macOS exports these stable libarchive C APIs in the SDK's libarchive.2.tbd,
// but omits its headers. No Homebrew library or runtime search path is used.
extern "C" {
struct archive;
struct archive_entry;
archive *archive_read_new(void);
int archive_read_support_format_zip(archive *);
int archive_read_support_filter_none(archive *);
int archive_read_set_format_option(archive *, const char *, const char *, const char *);
int archive_read_open_memory(archive *, const void *, size_t);
int archive_read_next_header(archive *, archive_entry **);
ssize_t archive_read_data(archive *, void *, size_t);
int archive_read_free(archive *);
const char *archive_entry_pathname(archive_entry *);
const char *archive_entry_symlink(archive_entry *);
const char *archive_entry_hardlink(archive_entry *);
mode_t archive_entry_filetype(archive_entry *);
mode_t archive_entry_perm(archive_entry *);
int64_t archive_entry_size(archive_entry *);
int archive_entry_is_encrypted(archive_entry *);
}

namespace octant::nightly_installation {
using namespace desktop_application;
constexpr const char *bundle_name = "Octant Nightly.app";
constexpr size_t max_compressed = 512ULL * 1024 * 1024;
constexpr uint64_t max_expanded = 4ULL * 1024 * 1024 * 1024;
constexpr size_t max_entries = 50000, max_depth = 32;
constexpr auto operation_bound = std::chrono::seconds(30);
constexpr auto close_bound = std::chrono::seconds(3);
struct Result { std::string kind = "refused", reason = "native-unavailable", version; bool running = false; };
struct Fd {
  int value = -1;
  explicit Fd(int fd = -1) : value(fd) {}
  ~Fd() { if (value >= 0) ::close(value); }
  Fd(const Fd &) = delete;
  Fd &operator=(const Fd &) = delete;
};
struct Stage {
  Fd parent, directory;
  std::string name, parent_path, version, team;
  struct stat identity{}, parent_identity{};
  bool committed = false;
};
struct State {
  std::atomic<bool> closed = false, busy = false, cleaning = false;
  std::atomic<unsigned> pending_jobs = 0;
  std::atomic<uint64_t> generation = 0;
  std::atomic<unsigned> pending_os = 0;
  std::mutex lock;
  std::condition_variable changed;
  std::shared_ptr<Stage> stage;
};
std::shared_ptr<State> state = std::make_shared<State>();
Result refused(const std::string &reason) { return {"refused", reason, {}, false}; }
bool same_node(const struct stat &a, const struct stat &b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }
bool current(const std::shared_ptr<State> &s, uint64_t generation, Deadline deadline) {
  return !s->closed && s->generation == generation && !expired(deadline);
}
std::string stopped_reason(const std::shared_ptr<State> &s, Deadline deadline) {
  return s->closed ? "closed" : expired(deadline) ? "deadline-exceeded" : "cancelled";
}
std::vector<std::string> components(const std::string &path) {
  std::vector<std::string> result;
  size_t start = 0;
  for (size_t at = 0; at <= path.size(); ++at) if (at == path.size() || path[at] == '/') {
    const auto part = path.substr(start, at - start);
    if (!part.empty()) result.push_back(part);
    start = at + 1;
  }
  return result;
}
bool path_parts(const char *raw, std::vector<std::string> &parts) {
  if (!raw) return false;
  if (strnlen(raw, 4097) > 4096) return false;
  const std::string path(raw);
  if (path.empty() || path.size() > 4096 || path.front() == '/' || path.find('\\') != std::string::npos || path.find("//") != std::string::npos) return false;
  parts = components(path);
  if (parts.empty() || parts.size() > max_depth || (parts[0] != bundle_name && parts[0] != "__MACOSX")) return false;
  for (const auto &part : parts) if (part == "." || part == ".." || part.size() > NAME_MAX) return false;
  return true;
}
bool internal_link(const std::vector<std::string> &path, const char *raw) {
  if (!raw) return false;
  if (strnlen(raw, 4097) > 4096) return false;
  std::string target(raw);
  if (target.empty() || target.size() > 4096 || target[0] == '/' || target.find('\\') != std::string::npos) return false;
  auto depth = path.size() - 1;
  for (const auto &part : components(target)) {
    if (part == ".") continue;
    if (part == "..") { if (depth <= 1) return false; --depth; }
    else { if (part.size() > NAME_MAX || ++depth > max_depth) return false; }
  }
  return true;
}
int directory_at(int root, const std::vector<std::string> &parts, size_t count) {
  int parent = dup(root);
  for (size_t i = 0; i < count && parent >= 0; ++i) {
    if (mkdirat(parent, parts[i].c_str(), 0700) != 0 && errno != EEXIST) { ::close(parent); return -1; }
    int next = openat(parent, parts[i].c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    ::close(parent); parent = next;
  }
  return parent;
}
bool remove_children(int fd) {
  DIR *entries = fdopendir(openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!entries) return false;
  bool okay = true;
  while (auto *entry = readdir(entries)) {
    std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    struct stat before{};
    if (fstatat(fd, name.c_str(), &before, AT_SYMLINK_NOFOLLOW) != 0) { okay = false; continue; }
    if (S_ISDIR(before.st_mode)) {
      Fd child(openat(fd, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
      struct stat identity{};
      if (child.value < 0 || fstat(child.value, &identity) != 0 || !same_node(before, identity) || !remove_children(child.value) || unlinkat(fd, name.c_str(), AT_REMOVEDIR) != 0) okay = false;
    } else if (unlinkat(fd, name.c_str(), 0) != 0) okay = false;
  }
  closedir(entries);
  return okay;
}
bool discard(const std::shared_ptr<Stage> &stage) {
  struct stat named{}, held{};
  if (stage->directory.value < 0) stage->directory.value = openat(stage->parent.value, stage->name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fstatat(stage->parent.value, stage->name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 || stage->directory.value < 0 || fstat(stage->directory.value, &held) != 0 || !same_node(named, stage->identity) || !same_node(held, stage->identity)) return false;
  return remove_children(stage->directory.value) && unlinkat(stage->parent.value, stage->name.c_str(), AT_REMOVEDIR) == 0;
}
bool resolved_link_inside(int root, const std::vector<std::string> &path,
                          const std::shared_ptr<State> &s, uint64_t generation,
                          Deadline deadline) {
  std::deque<std::string> pending(path.begin() + 1, path.end());
  std::vector<int> directories{dup(root)};
  if (directories[0] < 0) return false;
  bool valid = true;
  unsigned links = 0, steps = 0;
  while (valid && !pending.empty()) {
    if (!current(s, generation, deadline) || ++steps > 1024) { valid = false; break; }
    const auto name = pending.front(); pending.pop_front();
    if (name == ".") continue;
    if (name == "..") {
      if (directories.size() <= 1) { valid = false; break; }
      ::close(directories.back()); directories.pop_back(); continue;
    }
    struct stat node{};
    if (fstatat(directories.back(), name.c_str(), &node, AT_SYMLINK_NOFOLLOW) != 0) { valid = false; break; }
    if (S_ISLNK(node.st_mode)) {
      std::array<char, 4097> target{};
      const auto length = readlinkat(directories.back(), name.c_str(), target.data(), target.size());
      if (++links > 40 || length <= 0 || static_cast<size_t>(length) >= target.size() || target[0] == '/') { valid = false; break; }
      const auto parts = components(std::string(target.data(), length));
      for (auto at = parts.rbegin(); at != parts.rend(); ++at) pending.push_front(*at);
    } else if (!pending.empty()) {
      if (!S_ISDIR(node.st_mode)) { valid = false; break; }
      const int child = openat(directories.back(), name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat actual{};
      if (child < 0 || fstat(child, &actual) != 0 || !same_node(node, actual)) { if (child >= 0) ::close(child); valid = false; break; }
      directories.push_back(child);
    }
  }
  for (int fd : directories) ::close(fd);
  return valid;
}
bool extract_zip(const std::vector<uint8_t> &bytes, int destination, const std::shared_ptr<State> &s, uint64_t generation, Deadline deadline) {
  if (bytes.empty() || bytes.size() > max_compressed) return false;
  archive *reader = archive_read_new();
  if (!reader) return false;
  bool okay = archive_read_support_filter_none(reader) == 0 && archive_read_support_format_zip(reader) == 0 && archive_read_set_format_option(reader, "zip", "mac-ext", nullptr) == 0 && archive_read_open_memory(reader, bytes.data(), bytes.size()) == 0;
  uint64_t expanded = 0, metadata_bytes = 0;
  size_t count = 0;
  std::set<std::string> seen;
  std::vector<std::vector<std::string>> links, metadata_targets;
  std::map<std::string, std::string> spellings;
  archive_entry *entry = nullptr;
  int status = -1;
  while (okay && current(s, generation, deadline) && (status = archive_read_next_header(reader, &entry)) == 0) {
    std::vector<std::string> parts;
    if (++count > max_entries || !path_parts(archive_entry_pathname(entry), parts) || archive_entry_hardlink(entry) || archive_entry_is_encrypted(entry) != 0) { okay = false; break; }
    std::string key;
    for (const auto &part : parts) key += "/" + part;
    bool spelling_valid = true;
    std::string prefix;
    for (const auto &part : parts) {
      prefix += "/" + part;
      NSString *value = [NSString stringWithUTF8String:prefix.c_str()];
      if (!value) { spelling_valid = false; break; }
      std::string folded(value.precomposedStringWithCanonicalMapping.lowercaseString.UTF8String);
      auto found = spellings.find(folded);
      if (found != spellings.end() && found->second != prefix) { spelling_valid = false; break; }
      spellings[folded] = prefix;
    }
    if (!spelling_valid || !seen.insert(key).second) { okay = false; break; }
    const mode_t type = archive_entry_filetype(entry);
    if (type != S_IFREG && type != S_IFDIR && type != S_IFLNK) { okay = false; break; }
    const auto size = archive_entry_size(entry);
    if (size < 0 || static_cast<uint64_t>(size) > max_expanded - expanded) { okay = false; break; }
    if (parts[0] == "__MACOSX") {
      // Published ditto archives carry AppleDouble. Discard bounded resource
      // metadata; restoring it could alter quarantine or the validated code seal.
      if (type == S_IFDIR) {
        if (size != 0 || (parts.size() > 1 && parts[1] != bundle_name)) { okay = false; break; }
        if (parts.size() > 1) metadata_targets.emplace_back(parts.begin() + 1, parts.end());
        continue;
      }
      if (type != S_IFREG || parts.size() < 2 || !parts.back().starts_with("._") || parts.back().size() <= 2 || static_cast<uint64_t>(size) > 1024 * 1024 || static_cast<uint64_t>(size) > 16 * 1024 * 1024 - metadata_bytes) { okay = false; break; }
      std::vector<std::string> target(parts.begin() + 1, parts.end());
      target.back().erase(0, 2);
      if (target[0] != bundle_name) { okay = false; break; }
      metadata_targets.push_back(target);
      uint64_t read = 0;
      std::array<uint8_t, 64 * 1024> buffer{};
      while (okay && current(s, generation, deadline)) {
        const auto length = archive_read_data(reader, buffer.data(), buffer.size());
        if (length < 0) { okay = false; break; }
        if (length == 0) break;
        if (static_cast<uint64_t>(length) > 1024 * 1024 - read || static_cast<uint64_t>(length) > 16 * 1024 * 1024 - metadata_bytes || static_cast<uint64_t>(length) > max_expanded - expanded) { okay = false; break; }
        read += length; metadata_bytes += length; expanded += length;
      }
      if (read != static_cast<uint64_t>(size)) okay = false;
      continue;
    }
    Fd parent(directory_at(destination, parts, parts.size() - 1));
    if (parent.value < 0) { okay = false; break; }
    const auto &name = parts.back();
    if (type == S_IFDIR) {
      if (size != 0) { okay = false; break; }
      if (mkdirat(parent.value, name.c_str(), 0700) != 0 && errno != EEXIST) { okay = false; break; }
      Fd directory(openat(parent.value, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
      if (directory.value < 0 || fchmod(directory.value, 0755) != 0) { okay = false; break; }
    } else if (type == S_IFLNK) {
      const auto target = archive_entry_symlink(entry);
      if (!target || strnlen(target, 4097) > 4096 || strnlen(target, 4097) > max_expanded - expanded) { okay = false; break; }
      expanded += strlen(target);
      links.push_back(parts);
      if (!internal_link(parts, archive_entry_symlink(entry)) || symlinkat(archive_entry_symlink(entry), parent.value, name.c_str()) != 0) { okay = false; break; }
    } else {
      Fd file(openat(parent.value, name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
      if (file.value < 0) { okay = false; break; }
      uint64_t written = 0;
      std::array<uint8_t, 64 * 1024> buffer{};
      while (okay && current(s, generation, deadline)) {
        const ssize_t length = archive_read_data(reader, buffer.data(), buffer.size());
        if (length < 0) { okay = false; break; }
        if (length == 0) break;
        if (static_cast<uint64_t>(length) > max_expanded - expanded) { okay = false; break; }
        expanded += length; written += length;
        size_t offset = 0;
        while (offset < static_cast<size_t>(length)) {
          const auto done = write(file.value, buffer.data() + offset, length - offset);
          if (done < 0 && errno == EINTR) continue;
          if (done <= 0) { okay = false; break; }
          offset += done;
        }
      }
      if (written != static_cast<uint64_t>(size) || fchmod(file.value, (archive_entry_perm(entry) & 0111) ? 0755 : 0644) != 0) okay = false;
    }
  }
  okay = okay && status == 1 && count > 0 && current(s, generation, deadline);
  archive_read_free(reader);
  if (okay) {
    Fd bundle(openat(destination, bundle_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (bundle.value < 0) return false;
    for (const auto &target : metadata_targets) if (!resolved_link_inside(bundle.value, target, s, generation, deadline)) return false;
    for (const auto &link : links) if (!resolved_link_inside(bundle.value, link, s, generation, deadline)) return false;
  }
  return okay;
}
bool primary_self(ArtifactIdentity &identity, Deadline deadline, std::string &reason) {
  OwnedCF<SecCodeRef> dynamic;
  OwnedCF<SecStaticCodeRef> disk;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &dynamic.value) != errSecSuccess || SecCodeCopyStaticCode(dynamic.value, kSecCSDefaultFlags, &disk.value) != errSecSuccess || !validate_artifact(disk.value, dynamic.value, true, "", identity, deadline, reason)) return false;
  const int count = *_NSGetArgc();
  char **args = *_NSGetArgv();
  if (count < 1 || count > 4) { reason = "invalid-peer"; return false; }
  std::array<std::string_view, 3> entries;
  for (int i = 1; i < count; ++i) entries[i - 1] = args[i];
  if (!desktop_peer::ordinary_desktop_arguments(true, {entries.data(), static_cast<size_t>(count - 1)})) { reason = "invalid-peer"; return false; }
  return true;
}
std::string parent_path(const ArtifactIdentity &self) { return self.root.substr(0, self.root.rfind('/')); }
bool compatible_executable(const std::string &root) {
  Fd file(open((root + "/Contents/MacOS/Octant Nightly").c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  struct stat before{}, after{};
  mach_header_64 header{};
  if (file.value < 0 || fstat(file.value, &before) != 0 || !S_ISREG(before.st_mode) || pread(file.value, &header, sizeof(header), 0) != sizeof(header) || header.magic != MH_MAGIC_64 || header.cputype != CPU_TYPE_ARM64 || header.filetype != MH_EXECUTE || header.ncmds == 0 || header.ncmds > 1024 || header.sizeofcmds > 1024 * 1024 || static_cast<uint64_t>(before.st_size) < sizeof(header) + header.sizeofcmds) return false;
  std::vector<uint8_t> commands(header.sizeofcmds);
  size_t read = 0;
  while (read < commands.size()) {
    const auto count = pread(file.value, commands.data() + read, commands.size() - read, sizeof(header) + read);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    read += count;
  }
  const auto os = NSProcessInfo.processInfo.operatingSystemVersion;
  const uint32_t supported = (static_cast<uint32_t>(os.majorVersion) << 16) | (static_cast<uint32_t>(os.minorVersion) << 8) | static_cast<uint32_t>(os.patchVersion);
  bool found = false;
  size_t offset = 0;
  for (uint32_t index = 0; index < header.ncmds; ++index) {
    if (commands.size() - offset < sizeof(load_command)) return false;
    load_command command{};
    memcpy(&command, commands.data() + offset, sizeof(command));
    if (command.cmdsize < sizeof(command) || command.cmdsize > commands.size() - offset) return false;
    if (command.cmd == LC_BUILD_VERSION) {
      build_version_command version{};
      if (command.cmdsize < sizeof(version)) return false;
      memcpy(&version, commands.data() + offset, sizeof(version));
      if (version.platform != PLATFORM_MACOS || version.minos > supported) return false;
      found = true;
    } else if (command.cmd == LC_VERSION_MIN_MACOSX) {
      version_min_command version{};
      if (command.cmdsize < sizeof(version)) return false;
      memcpy(&version, commands.data() + offset, sizeof(version));
      if (version.version > supported) return false;
      found = true;
    }
    offset += command.cmdsize;
  }
  return found && offset == commands.size() && fstat(file.value, &after) == 0 && same_file(before, after);
}
bool disk_identity(const std::string &root, const std::string &team, ArtifactIdentity &identity, Deadline deadline, std::string &reason) {
  OwnedCF<CFURLRef> url;
  url.value = CFURLCreateFromFileSystemRepresentation(nullptr, reinterpret_cast<const UInt8 *>(root.data()), root.size(), true);
  OwnedCF<SecStaticCodeRef> disk;
  if (!url.value || SecStaticCodeCreateWithPath(url.value, kSecCSDefaultFlags, &disk.value) != errSecSuccess || !validate_artifact(disk.value, nullptr, false, team, identity, deadline, reason)) return false;
  if (!compatible_executable(root)) { reason = "incompatible-build"; return false; }
  return true;
}
Result inspect_target(const ArtifactIdentity &self, Deadline deadline) {
  const auto parent = parent_path(self), target = parent + "/" + bundle_name;
  Fd directory(open(parent.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (directory.value < 0) return refused("unwritable-location");
  auto *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"app.octant.desktop.nightly"];
  for (NSRunningApplication *app in running) {
    const auto path = std::string(app.bundleURL.path.fileSystemRepresentation ?: "");
    if (path != target) return refused("ambiguous-application");
  }
  struct stat info{};
  if (fstatat(directory.value, bundle_name, &info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? Result{"absent", {}, {}, false} : refused("ambiguous-application");
  if (!S_ISDIR(info.st_mode)) return refused("ambiguous-application");
  ArtifactIdentity candidate;
  std::string reason = "invalid-artifact";
  if (!disk_identity(target, self.team, candidate, deadline, reason) || candidate.root != target) return refused(expired(deadline) ? "deadline-exceeded" : reason == "incompatible-build" ? reason : "invalid-artifact");
  return {"installed", {}, candidate.version, running.count > 0};
}
} // namespace octant::nightly_installation

namespace octant::nightly_installation {
Result prepare(const std::shared_ptr<State> &s, const ArtifactIdentity &self, const std::vector<uint8_t> &bytes, const std::string &version, uint64_t generation, Deadline deadline) {
  { std::lock_guard guard(s->lock); if (s->stage) return refused("busy"); }
  const auto initial = inspect_target(self, deadline);
  if (initial.kind == "installed") return refused("already-installed");
  if (initial.kind != "absent") return initial;
  auto stage = std::make_shared<Stage>();
  stage->parent_path = parent_path(self); stage->team = self.team; stage->version = version;
  stage->parent.value = open(stage->parent_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (stage->parent.value < 0 || fstat(stage->parent.value, &stage->parent_identity) != 0 || faccessat(stage->parent.value, ".", W_OK, 0) != 0) return refused("unwritable-location");
  stage->name = ".octant-nightly-stage-" + std::string(NSUUID.UUID.UUIDString.UTF8String);
  if (mkdirat(stage->parent.value, stage->name.c_str(), 0700) != 0) return refused("unwritable-location");
  // Retain the owned name before any subsequent acquisition can fail. Cleanup
  // never reports closed while an unverified or inaccessible stage remains.
  { std::lock_guard guard(s->lock); s->stage = stage; }
  if (fstatat(stage->parent.value, stage->name.c_str(), &stage->identity, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(stage->identity.st_mode)) return refused("native-unavailable");
  stage->directory.value = openat(stage->parent.value, stage->name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat held{};
  if (stage->directory.value < 0 || fstat(stage->directory.value, &held) != 0 || !same_node(held, stage->identity)) return refused("native-unavailable");
  const auto valid = extract_zip(bytes, stage->directory.value, s, generation, deadline);
  const auto root = stage->parent_path + "/" + stage->name + "/" + bundle_name;
  ArtifactIdentity candidate;
  std::string reason = "invalid-artifact";
  if (!valid || !disk_identity(root, self.team, candidate, deadline, reason) || candidate.root != root || candidate.version != version || !current(s, generation, deadline)) {
    if (discard(stage)) { std::lock_guard guard(s->lock); if (s->stage == stage) s->stage.reset(); }
    return refused(current(s, generation, deadline) ? (reason == "incompatible-build" ? reason : "invalid-artifact") : stopped_reason(s, deadline));
  }
  return {"prepared", {}, {}, false};
}
bool publish_exclusive(const Stage &stage) {
  struct stat parent{}, named{}, held{}, bundle{};
  if (stat(stage.parent_path.c_str(), &parent) != 0 || !same_node(parent, stage.parent_identity) || fstatat(stage.parent.value, stage.name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 || fstat(stage.directory.value, &held) != 0 || !same_node(named, stage.identity) || !same_node(held, stage.identity) || fstatat(stage.directory.value, bundle_name, &bundle, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(bundle.st_mode)) { errno = ESTALE; return false; }
  return renameatx_np(stage.directory.value, bundle_name, stage.parent.value, bundle_name, RENAME_EXCL) == 0;
}
Result commit(const std::shared_ptr<State> &s, const ArtifactIdentity &self, uint64_t generation, Deadline deadline) {
  std::shared_ptr<Stage> stage;
  { std::lock_guard guard(s->lock); stage = s->stage; }
  if (!stage || stage->committed) return refused("invalid-artifact");
  const auto root = stage->parent_path + "/" + stage->name + "/" + bundle_name;
  ArtifactIdentity candidate;
  std::string reason = "invalid-artifact";
  if (stage->parent_path != parent_path(self) || stage->team != self.team || !disk_identity(root, self.team, candidate, deadline, reason) || candidate.root != root || candidate.version != stage->version) return refused(expired(deadline) ? "deadline-exceeded" : reason == "incompatible-build" ? reason : "invalid-artifact");
  NSURL *stagedURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:root.c_str()] isDirectory:YES];
  NSDictionary *quarantine = @{(__bridge NSString *)kLSQuarantineTypeKey: (__bridge NSString *)kLSQuarantineTypeOtherDownload,
    (__bridge NSString *)kLSQuarantineAgentBundleIdentifierKey: @"app.octant.desktop",
    (__bridge NSString *)kLSQuarantineAgentNameKey: @"Octant"};
  if (![stagedURL setResourceValue:quarantine forKey:NSURLQuarantinePropertiesKey error:nil]) return refused("unwritable-location");
  const auto target = inspect_target(self, deadline);
  if (target.kind != "absent") return target.kind == "installed" ? refused("already-installed") : target;
  if (!current(s, generation, deadline)) return refused(stopped_reason(s, deadline));
  // No await after this admission. RENAME_EXCL never replaces an existing target.
  // Descriptor/name identity is last-observed, not an atomic adversarial rename lock.
  if (!publish_exclusive(*stage)) return refused(errno == EEXIST ? "already-installed" : "unwritable-location");
  stage->committed = true;
  if (discard(stage)) { std::lock_guard guard(s->lock); if (s->stage == stage) s->stage.reset(); }
  return {"installed", {}, candidate.version, false};
}
struct TargetSnapshot {
  Fd parent;
  std::string path;
  struct stat parent_identity{}, target_identity{};
};
std::shared_ptr<TargetSnapshot> target_snapshot(const ArtifactIdentity &self) {
  auto snapshot = std::make_shared<TargetSnapshot>();
  snapshot->path = parent_path(self);
  snapshot->parent.value = open(snapshot->path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (snapshot->parent.value < 0 || fstat(snapshot->parent.value, &snapshot->parent_identity) != 0 || fstatat(snapshot->parent.value, bundle_name, &snapshot->target_identity, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(snapshot->target_identity.st_mode)) return nullptr;
  return snapshot;
}
bool same_target(const TargetSnapshot &snapshot) {
  struct stat parent{}, target{};
  return lstat(snapshot.path.c_str(), &parent) == 0 && S_ISDIR(parent.st_mode) && same_node(parent, snapshot.parent_identity) && fstatat(snapshot.parent.value, bundle_name, &target, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(target.st_mode) && same_node(target, snapshot.target_identity);
}
struct OpenCompletion { std::mutex lock; std::condition_variable changed; bool done = false, opened = false; std::string reason = "native-unavailable"; };
Result open_target(const std::shared_ptr<State> &s, const ArtifactIdentity &self, uint64_t generation, Deadline deadline) {
  const auto snapshot = target_snapshot(self);
  const auto inspected = inspect_target(self, deadline);
  if (inspected.kind != "installed") return inspected.kind == "absent" ? refused("not-installed") : inspected;
  if (!current(s, generation, deadline)) return refused(stopped_reason(s, deadline));
  auto completion = std::make_shared<OpenCompletion>();
  const auto target = parent_path(self) + "/" + bundle_name;
  s->pending_os.fetch_add(1);
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      // Expensive signature/fuse validation stays on the worker. The main queue
      // only checks its pinned filesystem identity and cancellation before the
      // OS launch; identity-to-launch is last-observed, not an atomic lock.
      if (!snapshot || !same_target(*snapshot) || !current(s, generation, deadline)) {
        { std::lock_guard guard(completion->lock); completion->done = true;
          completion->reason = !current(s, generation, deadline) ? stopped_reason(s, deadline) : "ambiguous-application"; }
        s->pending_os.fetch_sub(1); s->changed.notify_all(); completion->changed.notify_all(); return;
      }
      NSWorkspaceOpenConfiguration *configuration = NSWorkspaceOpenConfiguration.configuration;
      configuration.activates = YES;
      configuration.createsNewApplicationInstance = NO;
      NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:target.c_str()] isDirectory:YES];
      [NSWorkspace.sharedWorkspace openApplicationAtURL:url configuration:configuration completionHandler:^(NSRunningApplication *app, NSError *error) {
        { std::lock_guard guard(completion->lock); completion->opened = app != nil && error == nil; completion->done = true; }
        s->pending_os.fetch_sub(1); s->changed.notify_all(); completion->changed.notify_all();
      }];
    }
  });
  std::unique_lock guard(completion->lock);
  if (!completion->changed.wait_until(guard, deadline, [&] { return completion->done; })) return refused("deadline-exceeded");
  return completion->opened ? Result{"opened", {}, {}, false} : refused(completion->reason);
}
Result remove_target(const std::shared_ptr<State> &s, const ArtifactIdentity &self, uint64_t generation, Deadline deadline) {
  const auto snapshot = target_snapshot(self);
  const auto inspected = inspect_target(self, deadline);
  if (inspected.kind != "installed") return inspected.kind == "absent" ? refused("not-installed") : inspected;
  if (inspected.running) return refused("running");
  if (!current(s, generation, deadline)) return refused(stopped_reason(s, deadline));
  const auto target = parent_path(self) + "/" + bundle_name;
  const auto fresh = inspect_target(self, deadline);
  if (fresh.kind != "installed") return fresh;
  if (fresh.running) return refused("running");
  if (!snapshot || !same_target(*snapshot)) return refused("ambiguous-application");
  if (!current(s, generation, deadline)) return refused(stopped_reason(s, deadline));
  // Only the exact freshly validated sibling application is offered to Trash.
  // The host's shared data directory is never an input to this operation.
  NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:target.c_str()] isDirectory:YES];
  NSError *error = nil;
  return [NSFileManager.defaultManager trashItemAtURL:url resultingItemURL:nil error:&error] ? Result{"removed", {}, {}, false} : refused("unwritable-location");
}
Result cleanup(const std::shared_ptr<State> &s, bool terminal) {
  if (terminal) s->closed = true;
  const auto deadline = Clock::now() + close_bound;
  std::unique_lock guard(s->lock);
  if (!s->changed.wait_until(guard, deadline, [&] { return !s->busy && s->pending_os == 0 && s->pending_jobs == 0; })) return {"failed", "deadline-exceeded", {}, false};
  auto stage = s->stage;
  guard.unlock();
  if (stage && !discard(stage)) return {"failed", "native-unavailable", {}, false};
  guard.lock();
  if (s->stage == stage) s->stage.reset();
  return {terminal ? "closed" : "cancelled", {}, {}, false};
}

#ifndef OCTANT_INSTALLATION_TEST
struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string operation, version;
  std::vector<uint8_t> bytes;
  std::shared_ptr<State> owned;
  uint64_t generation = 0;
  bool main_thread = false;
  Result result;
};
void set(napi_env env, napi_value object, const char *name, const std::string &value) {
  napi_value text;
  napi_create_string_utf8(env, value.data(), value.size(), &text);
  napi_set_named_property(env, object, name, text);
}
void execute(napi_env, void *data) {
  auto &job = *static_cast<Job *>(data);
  @autoreleasepool {
    if (!job.main_thread) { job.result = refused("invalid-peer"); return; }
    if (job.operation == "close" || job.operation == "cancel") { job.result = cleanup(job.owned, job.operation == "close"); return; }
    if (job.owned->closed) { job.result = refused("closed"); return; }
    bool expected = false;
    if (!job.owned->busy.compare_exchange_strong(expected, true)) { job.result = refused("busy"); return; }
    try {
      const auto deadline = Clock::now() + operation_bound;
      ArtifactIdentity self;
      std::string reason = "unsigned-build";
      if (!current(job.owned, job.generation, deadline)) job.result = refused(stopped_reason(job.owned, deadline));
      else if (!primary_self(self, deadline, reason)) job.result = refused(reason == "unsigned-build" ? reason : "invalid-peer");
      else if (job.operation == "inspect") job.result = inspect_target(self, deadline);
      else if (job.operation == "prepareInstall") job.result = prepare(job.owned, self, job.bytes, job.version, job.generation, deadline);
      else if (job.operation == "commitInstall") job.result = commit(job.owned, self, job.generation, deadline);
      else if (job.operation == "open") job.result = open_target(job.owned, self, job.generation, deadline);
      else if (job.operation == "remove") job.result = remove_target(job.owned, self, job.generation, deadline);
    } catch (...) { job.result = refused("native-unavailable"); }
    job.owned->busy = false; job.owned->changed.notify_all();
  }
}
void complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Job> job(static_cast<Job *>(data));
  napi_value result;
  napi_create_object(env, &result);
  if (status != napi_ok) job->result = refused("native-unavailable");
  set(env, result, "kind", job->result.kind);
  if (!job->result.reason.empty()) set(env, result, "reason", job->result.reason);
  if (job->result.kind == "installed") {
    set(env, result, "version", job->result.version);
    napi_value running;
    napi_get_boolean(env, job->result.running, &running);
    napi_set_named_property(env, result, "running", running);
  }
  napi_resolve_deferred(env, job->deferred, result);
  napi_delete_async_work(env, job->work);
  if (job->operation == "cancel" || job->operation == "close") job->owned->cleaning = false;
  else job->owned->pending_jobs.fetch_sub(1);
  job->owned->changed.notify_all();
}
napi_value operation(napi_env env, napi_callback_info info) {
  void *tag = nullptr;
  size_t argc = 2;
  napi_value argv[2]{};
  napi_get_cb_info(env, info, &argc, argv, nullptr, &tag);
  const bool cleanup_operation = std::string_view(static_cast<const char *>(tag)) == "close" || std::string_view(static_cast<const char *>(tag)) == "cancel";
  if (!pthread_main_np() || (state->closed && !cleanup_operation) || state->cleaning || (!cleanup_operation && state->pending_jobs != 0)) {
    napi_value promise, result; napi_deferred deferred;
    napi_create_promise(env, &deferred, &promise); napi_create_object(env, &result);
    set(env, result, "kind", cleanup_operation ? "failed" : "refused");
    set(env, result, "reason", !pthread_main_np() ? "native-unavailable" : state->closed ? "closed" : "busy");
    napi_resolve_deferred(env, deferred, result); return promise;
  }
  auto job = std::make_unique<Job>();
  job->operation = static_cast<const char *>(tag);
  job->owned = state; job->generation = state->generation; job->main_thread = pthread_main_np();
  napi_value promise;
  napi_create_promise(env, &job->deferred, &promise);
  bool valid = argc == 0;
  if (job->operation == "prepareInstall" && argc == 2 && job->main_thread) {
    napi_typedarray_type type;
    size_t length = 0, offset = 0;
    void *bytes = nullptr;
    napi_value buffer;
    char version[65]{};
    size_t version_length = 0;
    valid = napi_get_typedarray_info(env, argv[0], &type, &length, &bytes, &buffer, &offset) == napi_ok && type == napi_uint8_array && length > 0 && length <= max_compressed && napi_get_value_string_utf8(env, argv[1], version, sizeof(version), &version_length) == napi_ok && version_length > 0 && version_length < sizeof(version) - 1;
    if (valid) { job->bytes.assign(static_cast<uint8_t *>(bytes), static_cast<uint8_t *>(bytes) + length); job->version.assign(version, version_length); }
  }
  if (!valid) {
    napi_value result;
    napi_create_object(env, &result); set(env, result, "kind", "refused"); set(env, result, "reason", "invalid-artifact"); napi_resolve_deferred(env, job->deferred, result); return promise;
  }
  if (cleanup_operation) state->cleaning = true;
  else state->pending_jobs.fetch_add(1);
  if (job->operation == "close") state->closed = true;
  if (job->operation == "cancel" || job->operation == "close") state->generation.fetch_add(1);
  napi_value name;
  napi_create_string_utf8(env, "Nightly installation", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, execute, complete, job.get(), &job->work) != napi_ok || napi_queue_async_work(env, job->work) != napi_ok) {
    if (job->work) napi_delete_async_work(env, job->work);
    if (cleanup_operation) state->cleaning = false;
    else state->pending_jobs.fetch_sub(1);
    state->changed.notify_all();
    napi_value result;
    napi_create_object(env, &result); set(env, result, "kind", job->operation == "close" || job->operation == "cancel" ? "failed" : "refused"); set(env, result, "reason", "native-unavailable"); napi_resolve_deferred(env, job->deferred, result); return promise;
  }
  job.release(); return promise;
}
napi_value initialize(napi_env env, napi_value exports) {
  for (const char *name : {"inspect", "prepareInstall", "commitInstall", "open", "remove", "cancel", "close"}) {
    napi_value function;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, operation, const_cast<char *>(name), &function);
    napi_set_named_property(env, exports, name, function);
  }
  if (pthread_main_np()) napi_add_env_cleanup_hook(env, [](void *) { state->closed = true; state->generation.fetch_add(1); }, nullptr);
  return exports;
}
#endif
} // namespace octant::nightly_installation
#ifndef OCTANT_INSTALLATION_TEST
NAPI_MODULE(NODE_GYP_MODULE_NAME, octant::nightly_installation::initialize)
#endif
