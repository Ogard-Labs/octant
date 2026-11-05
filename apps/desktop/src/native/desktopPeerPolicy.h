#pragma once
#include <array>
#include <cstdint>
#include <span>
#include <string_view>

namespace octant::desktop_peer {
inline bool ordinary_desktop_arguments(bool stable,
                                       std::span<const std::string_view> args) {
  if (args.size() > 3)
    return false;
  const std::string_view scheme = stable ? "octant://" : "octant-nightly://";
  bool psn = false, link = false, host_only = false;
  for (auto arg : args) {
    if (arg.size() > 16384)
      return false;
    if (!psn && arg.starts_with("-psn_")) {
      psn = true;
      continue;
    }
    if (stable && !host_only && !link && arg == "--octant-host-only") {
      host_only = true;
      continue;
    }
    if (!link && !host_only && arg.starts_with(scheme)) {
      link = true;
      continue;
    }
    return false;
  }
  return true;
}

enum class FusePolicy { trusted, absent, malformed, incompatible };

// Read-only format documented at electronjs.org/docs/latest/tutorial/fuses.
// A streaming decoder keeps mutable files out of mmap and bounds owned memory.
class FuseArtifactScan {
public:
  void feed(std::span<const uint8_t> bytes) {
    for (auto byte : bytes) {
      if (matches_ != 0 && collected_ < wire_.size())
        wire_[collected_++] = byte;
      if (byte == static_cast<uint8_t>(sentinel_[prefix_])) {
        if (++prefix_ == sentinel_.size()) {
          if (matches_ < 2)
            ++matches_;
          prefix_ = 0;
          collected_ = 0;
        }
      } else {
        // The pinned sentinel's only repeated nonempty prefix is its first
        // byte, so a mismatch can only begin again at that byte.
        prefix_ = byte == static_cast<uint8_t>(sentinel_[0]) ? 1 : 0;
      }
    }
  }
  FusePolicy finish() const {
    if (matches_ == 0)
      return FusePolicy::absent;
    if (matches_ != 1 || collected_ < 2)
      return FusePolicy::malformed;
    if (wire_[0] != 1 || wire_[1] != 9)
      return FusePolicy::incompatible;
    if (collected_ != wire_.size())
      return FusePolicy::malformed;
    for (size_t index = 2; index < wire_.size(); ++index)
      if (wire_[index] != '0' && wire_[index] != '1')
        return FusePolicy::malformed;
    for (size_t index : {size_t(0), size_t(2), size_t(3)})
      if (wire_[index + 2] != '0')
        return FusePolicy::incompatible;
    for (size_t index : {size_t(4), size_t(5)})
      if (wire_[index + 2] != '1')
        return FusePolicy::incompatible;
    return FusePolicy::trusted;
  }

private:
  static constexpr std::string_view sentinel_ =
      "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
  std::array<uint8_t, 11> wire_{};
  size_t prefix_ = 0, collected_ = 0;
  // Saturate rather than let repeated untrusted sentinels wrap the count.
  uint64_t matches_ = 0;
};
inline FusePolicy desktop_fuse_policy(std::span<const uint8_t> bytes) {
  FuseArtifactScan scan;
  scan.feed(bytes);
  return scan.finish();
}
} // namespace octant::desktop_peer
