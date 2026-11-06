#pragma once
// Pure Linux client trust rules: no syscalls, so the policy test runs them
// without sockets, processes or a real runtime folder.
#include <array>
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

// SHA-256 (FIPS 180-4), small and self-contained so the policy needs no
// crypto library. It only shapes a key; it carries no secret.
inline std::array<uint8_t, 32> sha256(std::string_view input) {
  static constexpr uint32_t k[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  std::string message(input);
  const uint64_t bits = static_cast<uint64_t>(input.size()) * 8;
  message.push_back(static_cast<char>(0x80));
  while (message.size() % 64 != 56)
    message.push_back(0);
  for (int shift = 56; shift >= 0; shift -= 8)
    message.push_back(static_cast<char>((bits >> shift) & 0xff));
  const auto rotate = [](uint32_t value, int count) {
    return (value >> count) | (value << (32 - count));
  };
  for (size_t block = 0; block < message.size(); block += 64) {
    uint32_t w[64];
    for (int index = 0; index < 16; ++index)
      w[index] =
          (uint32_t(uint8_t(message[block + index * 4])) << 24) |
          (uint32_t(uint8_t(message[block + index * 4 + 1])) << 16) |
          (uint32_t(uint8_t(message[block + index * 4 + 2])) << 8) |
          uint32_t(uint8_t(message[block + index * 4 + 3]));
    for (int index = 16; index < 64; ++index) {
      const uint32_t s0 = rotate(w[index - 15], 7) ^ rotate(w[index - 15], 18) ^
                          (w[index - 15] >> 3);
      const uint32_t s1 = rotate(w[index - 2], 17) ^ rotate(w[index - 2], 19) ^
                          (w[index - 2] >> 10);
      w[index] = w[index - 16] + s0 + w[index - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5],
             g = h[6], j = h[7];
    for (int index = 0; index < 64; ++index) {
      const uint32_t t1 = j + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
                          ((e & f) ^ (~e & g)) + k[index] + w[index];
      const uint32_t t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
                          ((a & b) ^ (a & c) ^ (b & c));
      j = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += j;
  }
  std::array<uint8_t, 32> digest{};
  for (int index = 0; index < 8; ++index)
    for (int byte = 0; byte < 4; ++byte)
      digest[index * 4 + byte] =
          static_cast<uint8_t>((h[index] >> (24 - byte * 8)) & 0xff);
  return digest;
}

// The peer key binds a lease to one process incarnation: its pid and its
// kernel start time on this boot, never an executable path or $APPIMAGE.
// The window lease owner and the host take a key of 64 lowercase hex
// characters (the macOS key is a SHA-256 of the audit token), so the Linux
// key is a SHA-256 of a fixed encoding. The boot id keeps a pid and start
// time from an earlier boot from naming the same key.
inline std::string peer_key(std::string_view boot_id, int64_t pid,
                            uint64_t start_time) {
  std::string encoding = "octant.linux-peer.v1";
  encoding.push_back('\0');
  encoding.append(boot_id);
  encoding.push_back('\0');
  encoding += std::to_string(pid);
  encoding.push_back('\0');
  encoding += std::to_string(start_time);
  static constexpr char hex[] = "0123456789abcdef";
  std::string key;
  for (auto byte : sha256(encoding)) {
    key += hex[byte >> 4];
    key += hex[byte & 15];
  }
  return key;
}

// /proc/sys/kernel/random/boot_id: one lowercase UUID and a newline.
inline std::optional<std::string> boot_id_text(std::string_view text) {
  if (ends_with(text, "\n"))
    text.remove_suffix(1);
  if (text.size() != 36 ||
      text.find_first_not_of("0123456789abcdef-") != std::string_view::npos)
    return std::nullopt;
  return std::string(text);
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
