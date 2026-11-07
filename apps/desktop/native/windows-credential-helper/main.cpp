#include <windows.h>
#include <wincred.h>
#include <array>
#include <cstdint>
#include <string>

namespace {
constexpr DWORD max_secret = 2560;
static_assert(max_secret == CRED_MAX_CREDENTIAL_BLOB_SIZE);
constexpr std::array<unsigned char, 4> magic{'O', 'C', 'C', 'R'};
enum class Status : unsigned char { ok, missing, invalid, unavailable, failed };

struct Secret {
  std::array<unsigned char, max_secret> bytes{};
  ~Secret() { SecureZeroMemory(bytes.data(), bytes.size()); }
};

bool transfer(HANDLE pipe, unsigned char* buffer, DWORD size, bool write) {
  DWORD offset = 0;
  while (offset < size) {
    DWORD count = 0;
    const bool success = write
      ? WriteFile(pipe, buffer + offset, size - offset, &count, nullptr) != FALSE
      : ReadFile(pipe, buffer + offset, size - offset, &count, nullptr) != FALSE;
    if (!success || count == 0) return false;
    offset += count;
  }
  return true;
}

bool uuid(const unsigned char* text) {
  for (size_t i = 0; i < 36; ++i) {
    const auto c = text[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
    } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

DWORD little_endian(const unsigned char* data) {
  return static_cast<DWORD>(data[0]) | (static_cast<DWORD>(data[1]) << 8) |
    (static_cast<DWORD>(data[2]) << 16) | (static_cast<DWORD>(data[3]) << 24);
}

Status failure(DWORD error) {
  if (error == ERROR_NOT_FOUND) return Status::missing;
  if (error == ERROR_NO_SUCH_LOGON_SESSION || error == ERROR_ACCESS_DENIED) return Status::unavailable;
  return Status::failed;
}

bool reply(HANDLE output, Status status, unsigned char* secret = nullptr, DWORD size = 0) {
  std::array<unsigned char, 9> header{'O', 'C', 'C', 'R', static_cast<unsigned char>(status)};
  for (unsigned int i = 0; i < 4; ++i) header[5 + i] = static_cast<unsigned char>((size >> (8 * i)) & 255);
  return transfer(output, header.data(), static_cast<DWORD>(header.size()), true) &&
    (size == 0 || transfer(output, secret, size, true));
}

int run(HANDLE input, HANDLE output) {
  std::array<unsigned char, 83> header{};
  Secret secret;
  if (!transfer(input, header.data(), static_cast<DWORD>(header.size()), false))
    return reply(output, Status::invalid) ? 0 : 1;
  const DWORD size = little_endian(header.data() + 79);
  const auto operation = header[5];
  bool valid = header[4] == 1 && operation >= 1 && operation <= 4 && header[6] <= 1 &&
    uuid(header.data() + 7) && uuid(header.data() + 43) && size <= max_secret &&
    (operation == 1 ? size > 0 : size == 0);
  for (size_t i = 0; i < magic.size(); ++i) valid = valid && header[i] == magic[i];
  if (!valid || !transfer(input, secret.bytes.data(), size, false))
    return reply(output, Status::invalid) ? 0 : 1;
  unsigned char extra = 0;
  DWORD received = 0;
  const bool ended = ReadFile(input, &extra, 1, &received, nullptr) != FALSE;
  if ((ended && received != 0) || (!ended && GetLastError() != ERROR_BROKEN_PIPE))
    return reply(output, Status::invalid) ? 0 : 1;
  if (size != 0 && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      reinterpret_cast<const char*>(secret.bytes.data()), static_cast<int>(size), nullptr, 0) == 0)
    return reply(output, Status::invalid) ? 0 : 1;

  std::wstring target = header[6] == 0 ? L"Octant/provider/v1/octant/" : L"Octant/provider/v1/octant-nightly-test-data/";
  for (size_t i = 7; i < 43; ++i) target += static_cast<wchar_t>(header[i]);
  target += L"/";
  for (size_t i = 43; i < 79; ++i) target += static_cast<wchar_t>(header[i]);
  if (operation == 1) {
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.data();
    credential.CredentialBlobSize = size;
    credential.CredentialBlob = secret.bytes.data();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    const Status status = CredWriteW(&credential, 0) ? Status::ok : failure(GetLastError());
    return reply(output, status) ? 0 : 1;
  }
  if (operation == 4) {
    const Status status = CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0) ? Status::ok : failure(GetLastError());
    return reply(output, status == Status::missing ? Status::ok : status) ? 0 : 1;
  }
  PCREDENTIALW credential = nullptr;
  if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential))
    return reply(output, failure(GetLastError())) ? 0 : 1;
  // The single native write is atomic. Only the protected secret blob holds
  // key bytes; attributes and user-visible metadata never hold overflow.
  const DWORD stored_size = credential->CredentialBlobSize;
  const bool sound = credential->Type == CRED_TYPE_GENERIC && stored_size > 0 &&
    stored_size <= max_secret && credential->CredentialBlob != nullptr;
  if (sound && operation == 3) CopyMemory(secret.bytes.data(), credential->CredentialBlob, stored_size);
  if (credential->CredentialBlob != nullptr) SecureZeroMemory(credential->CredentialBlob, stored_size);
  CredFree(credential);
  return reply(output, sound ? Status::ok : Status::failed,
    operation == 3 && sound ? secret.bytes.data() : nullptr,
    operation == 3 && sound ? stored_size : 0) ? 0 : 1;
}
} // namespace

int wmain(int argc, wchar_t**) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  // This private protocol is not a command-line credential tool. Normal use
  // is one broker-owned child, one request, one reply, then process exit.
  if (argc != 1 || GetFileType(input) != FILE_TYPE_PIPE || GetFileType(output) != FILE_TYPE_PIPE) return 1;
  try { return run(input, output); }
  catch (...) { return reply(output, Status::failed) ? 0 : 1; }
}
