#include "desktopPeerPolicy.h"
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
using octant::desktop_peer::desktop_fuse_policy;
using octant::desktop_peer::FusePolicy;
int main(int argc, char **argv) {
  if (argc == 2) {
    std::ifstream input(argv[1], std::ios::binary);
    if (!input)
      return 2;
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(input)), {});
    auto result = desktop_fuse_policy(bytes);
    std::cout << (result == FusePolicy::trusted ? "trusted" : "refused")
              << '\n';
    return 0;
  }
  const std::array<std::string_view, 1> host_only = {"--octant-host-only"};
  const std::array<std::string_view, 2> mixed = {"--octant-host-only",
                                                 "octant://code/project/test"};
  const std::array<std::string_view, 2> duplicate_role = {"--octant-host-only",
                                                          "--octant-host-only"};
  const std::array<std::string_view, 2> runtime = {"--octant-host-only",
                                                   "--inspect"};
  const std::array<std::string_view, 2> terminal = {"--octant-terminal-cli",
                                                    "--help"};
  if (!octant::desktop_peer::ordinary_desktop_arguments(true, host_only) ||
      octant::desktop_peer::ordinary_desktop_arguments(false, host_only) ||
      octant::desktop_peer::ordinary_desktop_arguments(true, mixed) ||
      octant::desktop_peer::ordinary_desktop_arguments(true, duplicate_role) ||
      octant::desktop_peer::ordinary_desktop_arguments(true, runtime) ||
      octant::desktop_peer::ordinary_desktop_arguments(true, terminal))
    return 10;
  const std::string sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
  std::vector<uint8_t> bytes(sentinel.begin(), sentinel.end());
  bytes.push_back(1);
  bytes.push_back(9);
  for (char state : std::string("000011011"))
    bytes.push_back(state);
  if (desktop_fuse_policy(bytes) != FusePolicy::trusted)
    return 3;
  for (size_t split = 0; split <= bytes.size(); ++split) {
    octant::desktop_peer::FuseArtifactScan scan;
    scan.feed(std::span<const uint8_t>(bytes.data(), split));
    scan.feed(
        std::span<const uint8_t>(bytes.data() + split, bytes.size() - split));
    if (scan.finish() != FusePolicy::trusted)
      return 9;
  }
  for (size_t fuse : {size_t(0), size_t(2), size_t(3), size_t(4), size_t(5)}) {
    auto unsafe = bytes;
    unsafe[sentinel.size() + 2 + fuse] = fuse < 4 ? '1' : '0';
    if (desktop_fuse_policy(unsafe) == FusePolicy::trusted) {
      std::cerr << "unsafe fuse accepted\n";
      return 4;
    }
  }
  auto unknown = bytes;
  unknown[sentinel.size()] = 99;
  if (desktop_fuse_policy(unknown) != FusePolicy::incompatible)
    return 5;
  for (size_t length = 0; length < bytes.size(); ++length) {
    if (desktop_fuse_policy(std::span<const uint8_t>(bytes.data(), length)) ==
        FusePolicy::trusted)
      return 6;
  }
  auto invalid = bytes;
  invalid[sentinel.size() + 2] = 0xff;
  if (desktop_fuse_policy(invalid) == FusePolicy::trusted)
    return 7;
  auto duplicate = bytes;
  duplicate.insert(duplicate.end(), bytes.begin(), bytes.end());
  if (desktop_fuse_policy(duplicate) == FusePolicy::trusted)
    return 8;
  std::cout << "bounded fuse policy passed\n";
}
