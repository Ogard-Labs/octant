#pragma once
#include <windows.h>
#include <cstdint>
#include <cstring>

namespace octant::desktop_peer_win32 {
struct Wire {
  uint32_t magic, protocol, operation, status;
  uint64_t generation, sequence;
  char window[37], version[64], payload[4096];
  // Fixed frames include ABI padding. Initialize/copy the complete byte range,
  // not just the members, so no stack bytes can enter the local transport.
  Wire() { std::memset(this, 0, sizeof(*this)); magic = 0x4f435450; protocol = 1; }
  Wire(const Wire& source) { std::memcpy(this, &source, sizeof(*this)); }
  Wire& operator=(const Wire& source) { if (this != &source) std::memcpy(this, &source, sizeof(*this)); return *this; }
  ~Wire() { SecureZeroMemory(this, sizeof(*this)); }
};
} // namespace octant::desktop_peer_win32
