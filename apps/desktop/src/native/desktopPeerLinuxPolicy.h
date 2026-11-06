#pragma once
// Pure Linux client trust rules: no syscalls, so the policy test runs them
// without sockets, processes or a real runtime folder.
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <vector>

namespace octant::desktop_peer_linux {

constexpr uint32_t wire_magic = 0x4f435450;
constexpr uint32_t operation_status = 0, operation_register = 1,
                   operation_renew = 2, operation_revoke = 3;
constexpr uint32_t status_accepted = 1, status_refused = 2;
constexpr size_t max_peers = 32;

// One fixed-size record per SOCK_SEQPACKET message, in both directions. The
// sizes match the macOS window protocol: a 36-character client handle and a
// 4 KiB payload, NUL-terminated.
struct Wire {
  uint32_t magic = wire_magic, protocol = 1, operation = 0, status = 0;
  uint64_t generation = 0;
  char window[37]{};
  char version[64]{};
  char payload[4096]{};
};

// A client that accepts the native-main bootstrap fields names this after the
// payload's leading NUL, as on macOS. An empty marker gets the original reply.
constexpr char native_main_marker[] = "native-main-v1";

inline bool terminated(const char *text, size_t size) {
  return std::memchr(text, 0, size) != nullptr;
}

inline bool request_payload(const Wire &request, bool &native_main) {
  if (request.payload[0] != 0)
    return false;
  const char *text = request.payload + 1;
  const size_t length = strnlen(text, sizeof(request.payload) - 1);
  if (length == sizeof(request.payload) - 1)
    return false;
  native_main = length != 0;
  return length == 0 || std::strcmp(text, native_main_marker) == 0;
}

// A request names an operation the server knows. Window operations carry an
// exact 36-character handle and a generation a JavaScript number can hold.
inline bool valid_request(const Wire &request, bool &native_main) {
  native_main = false;
  if (request.magic != wire_magic || request.protocol != 1 ||
      request.status != 0 || request.operation > operation_revoke ||
      !terminated(request.version, sizeof(request.version)))
    return false;
  if (request.operation == operation_status)
    return request.generation == 0 && request.window[0] == 0 &&
           request.payload[0] == 0 &&
           strnlen(request.payload + 1, sizeof(request.payload) - 1) == 0;
  return request.generation >= 1 &&
         request.generation <= 9007199254740991ULL &&
         request.window[36] == 0 && std::strlen(request.window) == 36 &&
         request_payload(request, native_main);
}

// A reply answers the request it names, and nothing it carries is unbounded.
inline bool valid_reply(const Wire &reply, const Wire &request) {
  if (reply.magic != wire_magic || reply.protocol != 1 ||
      reply.operation != request.operation ||
      reply.generation != request.generation ||
      std::memcmp(reply.window, request.window, sizeof(reply.window)) != 0 ||
      !terminated(reply.version, sizeof(reply.version)) ||
      !terminated(reply.payload, sizeof(reply.payload)))
    return false;
  if (request.operation == operation_status)
    return reply.status == status_refused ||
           (reply.status == status_accepted && reply.version[0] != 0);
  return reply.status == 0;
}

// The private per-user runtime folder: a real directory the person owns that
// no one else can enter. Anything else is refused before a socket is touched.
inline bool private_directory(const struct stat &metadata, uid_t uid) {
  return S_ISDIR(metadata.st_mode) && metadata.st_uid == uid &&
         (metadata.st_mode & 077) == 0;
}

inline bool ends_with(std::string_view value, std::string_view suffix) {
  return value.size() >= suffix.size() &&
         value.substr(value.size() - suffix.size()) == suffix;
}

inline std::string_view parent_of(std::string_view path) {
  const auto slash = path.rfind('/');
  return slash == std::string_view::npos || slash == 0
             ? std::string_view{}
             : path.substr(0, slash);
}

// Both endpoint files live side by side in one absolute folder, carry the
// host-runtime suffixes, and the socket fits a path socket address. The
// binding never accepts an abstract name.
inline bool endpoint_paths(std::string_view socket, std::string_view record) {
  constexpr size_t sun_path_size = 108;
  const auto clean = [](std::string_view path) {
    return !path.empty() && path.front() == '/' &&
           path.find('\0') == std::string_view::npos &&
           path.find("/../") == std::string_view::npos &&
           path.find("/./") == std::string_view::npos &&
           path.find("//") == std::string_view::npos && path.size() < 4096;
  };
  if (!clean(socket) || !clean(record) || socket.size() >= sun_path_size ||
      !ends_with(socket, ".windows.v1.sock") ||
      !ends_with(record, ".launcher.json"))
    return false;
  const auto folder = parent_of(socket);
  if (folder.empty() || folder != parent_of(record))
    return false;
  const auto socket_identity = socket.substr(
      folder.size() + 1, socket.size() - folder.size() - 1 - 16);
  const auto record_identity = record.substr(
      folder.size() + 1, record.size() - folder.size() - 1 - 14);
  return !socket_identity.empty() && socket_identity == record_identity &&
         socket_identity.find_first_not_of("0123456789abcdef") ==
             std::string_view::npos;
}

inline bool version_text(std::string_view version) {
  return !version.empty() && version.size() < 64 &&
         version.find_first_not_of(
             "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-") ==
             std::string_view::npos;
}

// Field 22 of /proc/<pid>/stat, counted after the last ')' so a command name
// holding spaces or parentheses cannot shift it.
inline std::optional<uint64_t> process_start_time(std::string_view stat) {
  const auto close = stat.rfind(')');
  if (close == std::string_view::npos)
    return std::nullopt;
  std::string_view rest = stat.substr(close + 1);
  // After ')' the next field is 3 (state); start time is field 22.
  int field = 2;
  size_t index = 0;
  while (index < rest.size()) {
    while (index < rest.size() && rest[index] == ' ')
      ++index;
    if (index >= rest.size())
      break;
    const size_t begin = index;
    while (index < rest.size() && rest[index] != ' ' && rest[index] != '\n')
      ++index;
    if (++field == 22) {
      const auto value = rest.substr(begin, index - begin);
      if (value.empty() || value.size() > 20 ||
          value.find_first_not_of("0123456789") != std::string_view::npos)
        return std::nullopt;
      uint64_t parsed = 0;
      for (char digit : value) {
        if (parsed > (UINT64_MAX - 9) / 10)
          return std::nullopt;
        parsed = parsed * 10 + static_cast<uint64_t>(digit - '0');
      }
      return parsed;
    }
    if (index < rest.size() && rest[index] == '\n')
      break;
  }
  return std::nullopt;
}

// The pid a pidfd refers to, from its /proc/self/fdinfo entry.
inline std::optional<int64_t> fdinfo_pid(std::string_view fdinfo) {
  size_t at = 0;
  while (at < fdinfo.size()) {
    const auto end = fdinfo.find('\n', at);
    const auto line = fdinfo.substr(
        at, end == std::string_view::npos ? std::string_view::npos : end - at);
    if (line.starts_with("Pid:")) {
      auto value = line.substr(4);
      while (!value.empty() && (value.front() == '\t' || value.front() == ' '))
        value.remove_prefix(1);
      if (value.empty() || value.size() > 10)
        return std::nullopt;
      bool negative = value.front() == '-';
      if (negative)
        value.remove_prefix(1);
      if (value.empty() ||
          value.find_first_not_of("0123456789") != std::string_view::npos)
        return std::nullopt;
      int64_t parsed = 0;
      for (char digit : value)
        parsed = parsed * 10 + (digit - '0');
      return negative ? -parsed : parsed;
    }
    if (end == std::string_view::npos)
      break;
    at = end + 1;
  }
  return std::nullopt;
}

// The peer key binds a lease to one process incarnation: its pid and its
// kernel start time, never an executable path, a hash or $APPIMAGE.
inline std::string peer_key(int64_t pid, uint64_t start_time) {
  return std::to_string(pid) + ":" + std::to_string(start_time);
}

struct LauncherRecord {
  std::string app_image;
  uint64_t device = 0, inode = 0;
};

inline std::optional<uint64_t> decimal(std::string_view text) {
  if (text.empty() || text.size() > 20 ||
      text.find_first_not_of("0123456789") != std::string_view::npos ||
      (text.size() > 1 && text.front() == '0'))
    return std::nullopt;
  uint64_t parsed = 0;
  for (char digit : text) {
    if (parsed > (UINT64_MAX - 9) / 10)
      return std::nullopt;
    parsed = parsed * 10 + static_cast<uint64_t>(digit - '0');
  }
  return parsed;
}

// Exactly the one line Octant writes. Only the escapes a plain absolute path
// needs are accepted, so a control character or Unicode escape refuses.
inline std::optional<LauncherRecord> parse_launcher_record(std::string_view text) {
  if (ends_with(text, "\n"))
    text.remove_suffix(1);
  constexpr std::string_view head = "{\"schemaVersion\":1,\"appImage\":\"";
  if (!text.starts_with(head))
    return std::nullopt;
  text.remove_prefix(head.size());
  LauncherRecord record;
  size_t index = 0;
  for (;; ++index) {
    if (index >= text.size())
      return std::nullopt;
    const char value = text[index];
    if (value == '"')
      break;
    if (static_cast<unsigned char>(value) < 0x20)
      return std::nullopt;
    if (value == '\\') {
      if (++index >= text.size() || (text[index] != '"' && text[index] != '\\'))
        return std::nullopt;
      record.app_image += text[index];
      continue;
    }
    record.app_image += value;
  }
  text.remove_prefix(index + 1);
  constexpr std::string_view device_head = ",\"device\":\"";
  if (!text.starts_with(device_head))
    return std::nullopt;
  text.remove_prefix(device_head.size());
  const auto device_end = text.find('"');
  if (device_end == std::string_view::npos)
    return std::nullopt;
  const auto device = decimal(text.substr(0, device_end));
  text.remove_prefix(device_end + 1);
  constexpr std::string_view inode_head = ",\"inode\":\"";
  if (!device || !text.starts_with(inode_head))
    return std::nullopt;
  text.remove_prefix(inode_head.size());
  const auto inode_end = text.find('"');
  if (inode_end == std::string_view::npos)
    return std::nullopt;
  const auto inode = decimal(text.substr(0, inode_end));
  if (!inode || text.substr(inode_end + 1) != "}")
    return std::nullopt;
  if (record.app_image.empty() || record.app_image.front() != '/' ||
      record.app_image.size() >= 4096)
    return std::nullopt;
  record.device = *device;
  record.inode = *inode;
  return record;
}

// The record file itself: a regular private file the person owns.
inline bool launcher_record_file(const struct stat &metadata, uid_t uid) {
  return S_ISREG(metadata.st_mode) && metadata.st_uid == uid &&
         (metadata.st_mode & 077) == 0 && metadata.st_size > 0 &&
         metadata.st_size <= 8192;
}

// The AppImage it names: still the same regular file, owned by the person,
// writable by no one else. Moving, replacing or loosening it refuses.
inline bool launcher_target(const struct stat &metadata, uid_t uid,
                            const LauncherRecord &record) {
  return S_ISREG(metadata.st_mode) && metadata.st_uid == uid &&
         (metadata.st_mode & (S_IWGRP | S_IWOTH)) == 0 &&
         (metadata.st_mode & S_IXUSR) != 0 &&
         static_cast<uint64_t>(metadata.st_dev) == record.device &&
         static_cast<uint64_t>(metadata.st_ino) == record.inode;
}

// A host-only Octant starts with only what a desktop session needs to show
// nothing and reach its keyring: never loader, Electron, Node or AppImage
// variables inherited from Nightly.
inline bool launch_environment_name(std::string_view name) {
  static constexpr std::string_view exact[] = {
      "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE",
      "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
      "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
      "XDG_DATA_DIRS", "XDG_CONFIG_DIRS", "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP", "DBUS_SESSION_BUS_ADDRESS",
      "OCTANT_DATA_DIR", "APPIMAGE_EXTRACT_AND_RUN"};
  for (auto allowed : exact)
    if (name == allowed)
      return true;
  return name.starts_with("LC_") && name.size() > 3 &&
         name.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ_") ==
             std::string_view::npos;
}

inline std::vector<std::string>
launch_environment(std::span<const std::string_view> environment) {
  std::vector<std::string> kept;
  for (auto entry : environment) {
    const auto equals = entry.find('=');
    if (equals == std::string_view::npos || equals == 0 ||
        entry.size() > 16384 || kept.size() >= 64)
      continue;
    if (launch_environment_name(entry.substr(0, equals)))
      kept.emplace_back(entry);
  }
  return kept;
}
} // namespace octant::desktop_peer_linux
