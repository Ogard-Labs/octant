#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <atomic>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <memory>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { reset(); value = other.value; other.value = INVALID_HANDLE_VALUE; } return *this; }
  ~Handle() { reset(); }
  void reset() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
bool token_sid(HANDLE process, std::vector<unsigned char>& output) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return false;
  Handle token(raw); DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  if (size == 0 || size > 65536) return false;
  std::vector<unsigned char> bytes(size);
  if (!GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size)) return false;
  const PSID sid = reinterpret_cast<const TOKEN_USER*>(bytes.data())->User.Sid;
  if (!IsValidSid(sid)) return false;
  const DWORD length = GetLengthSid(sid); output.resize(length); return CopySid(length, output.data(), sid) != FALSE;
}
Handle open_directory(const std::wstring& path) {
  Handle handle(CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  FILE_ATTRIBUTE_TAG_INFO facts{};
  if (!handle || !GetFileInformationByHandleEx(handle.value, FileAttributeTagInfo, &facts, sizeof(facts)) ||
      (facts.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (facts.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Handle();
  return handle;
}
#include "../../packages/host-runtime/native/windows-host-owner/desktopArtifact.h"

// Fixed categories and security facts only; no paths, SIDs or descriptors.
void diagnostic(const char* stage, size_t index, HANDLE handle, const DesktopArtifactTrust* trust) {
  const DWORD failure = GetLastError();
  bool trusted_owner = false; DWORD ace_count = 0;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (handle && handle != INVALID_HANDLE_VALUE && trust) {
    PSID principal = nullptr; PACL acl = nullptr;
    if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &principal, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS) {
      trusted_owner = trust->accepts(principal);
      if (acl && IsValidAcl(acl)) {
        ace_count = acl->AceCount;
        for (DWORD entry = 0; entry < acl->AceCount && entry < 64; ++entry) {
          void* raw = nullptr;
          if (!GetAce(acl, entry, &raw)) break;
          const auto header = static_cast<const ACE_HEADER*>(raw);
          if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
          bool trusted_principal = false; DWORD mask = 0;
          if ((header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE) && header->AceSize >= sizeof(ACCESS_ALLOWED_ACE)) {
            const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
            const PSID sid = const_cast<DWORD*>(&ace->SidStart);
            if (IsValidSid(sid) && GetLengthSid(sid) <= header->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart)) trusted_principal = trust->accepts(sid);
            mask = ace->Mask;
          }
          std::printf("{\"artifactAce\":%lu,\"type\":%u,\"flags\":%u,\"mask\":%lu,\"trustedPrincipal\":%s}\n",
            entry, static_cast<unsigned int>(header->AceType), static_cast<unsigned int>(header->AceFlags), mask, trusted_principal ? "true" : "false");
        }
      }
    }
  }
  if (descriptor) LocalFree(descriptor);
  std::printf("{\"artifactAdmissionStage\":\"%s\",\"ancestorIndex\":%zu,\"trustedOwner\":%s,\"aceCount\":%lu,\"win32Code\":%lu}\n",
    stage, index, trusted_owner ? "true" : "false", ace_count, failure);
}
void diagnose_artifact(const std::wstring& image) {
  std::wstring ordinary;
  if (!desktop_image_path(image, ordinary)) { diagnostic("image-path", 0, nullptr, nullptr); return; }
  const std::wstring drive = ordinary.substr(0, 3);
  const UINT type = GetDriveTypeW(drive.c_str());
  if (type != DRIVE_FIXED && type != DRIVE_REMOVABLE) { diagnostic("drive-type", 0, nullptr, nullptr); return; }
  DesktopArtifactTrust trust;
  if (!desktop_artifact_trust(trust)) { diagnostic("trusted-principals", 0, nullptr, nullptr); return; }
  std::vector<Handle> held;
  held.push_back(open_directory(drive));
  if (!held.back()) { diagnostic("root-open", 0, nullptr, nullptr); return; }
  if (!desktop_artifact_acl(held.back().value, trust, true, true)) { diagnostic("root-acl", 0, held.back().value, &trust); return; }
  const size_t leaf = ordinary.find_last_of(L'\\');
  std::wstring current = drive;
  size_t start = 3, index = 0;
  while (start < leaf) {
    const size_t next = ordinary.find(L'\\', start);
    if (next == std::wstring::npos || next > leaf || next == start) { diagnostic("ancestor-shape", index, nullptr, nullptr); return; }
    const std::wstring component = ordinary.substr(start, next - start);
    if (!desktop_artifact_component(component)) { diagnostic("ancestor-component", index, nullptr, nullptr); return; }
    if (current.back() != L'\\') current += L'\\'; current += component;
    if (next == leaf) break;
    ++index; held.push_back(open_directory(current));
    if (!held.back()) { diagnostic("ancestor-open", index, nullptr, nullptr); return; }
    if (!desktop_artifact_acl(held.back().value, trust, true, true)) { diagnostic("ancestor-acl", index, held.back().value, &trust); return; }
    start = next + 1;
  }
  held.push_back(open_directory(current));
  if (!held.back()) { diagnostic("package-open", index + 1, nullptr, nullptr); return; }
  if (!desktop_artifact_acl(held.back().value, trust, true, false)) { diagnostic("package-acl", index + 1, held.back().value, &trust); return; }
  Handle file(CreateFileW(ordinary.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file) { diagnostic("image-open", 0, nullptr, nullptr); return; }
  diagnostic(desktop_artifact_file(file.value, trust) ? "image-canonical-or-tree" : "image-file", 0, file.value, &trust);
}

bool absent(const std::wstring& path) {
  if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  const DWORD failure = GetLastError(); return failure == ERROR_FILE_NOT_FOUND || failure == ERROR_PATH_NOT_FOUND;
}
bool same_file(HANDLE a, HANDLE b) {
  FILE_ID_INFO first{}, second{};
  return GetFileInformationByHandleEx(a, FileIdInfo, &first, sizeof(first)) && GetFileInformationByHandleEx(b, FileIdInfo, &second, sizeof(second)) &&
    first.VolumeSerialNumber == second.VolumeSerialNumber && std::memcmp(first.FileId.Identifier, second.FileId.Identifier, 16) == 0;
}
bool create_file(const std::wstring& path, PSECURITY_DESCRIPTOR security) {
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), security, FALSE};
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  const char content[] = "Owned artifact ACL fixture; never executed."; DWORD wrote = 0;
  return file && WriteFile(file.value, content, sizeof(content), &wrote, nullptr) && wrote == sizeof(content) && FlushFileBuffers(file.value);
}
struct Fixture {
  std::wstring root;
  PSECURITY_DESCRIPTOR safe = nullptr, unsafe = nullptr;
  bool created = false;
  std::vector<std::wstring> files, directories;
  bool finish() {
    bool cleaned = true;
    for (auto it = files.rbegin(); it != files.rend(); ++it) if (!DeleteFileW(it->c_str()) && !absent(*it)) cleaned = false;
    for (auto it = directories.rbegin(); it != directories.rend(); ++it) if (!RemoveDirectoryW(it->c_str()) && !absent(*it)) cleaned = false;
    if (created && !RemoveDirectoryW(root.c_str()) && !absent(root)) cleaned = false;
    std::printf("{\"ownedArtifactFixtureAbsent\":%s}\n", cleaned && (!created || absent(root)) ? "true" : "false");
    files.clear(); directories.clear(); created = false; return cleaned;
  }
  ~Fixture() { if (created) finish(); if (safe) LocalFree(safe); if (unsafe) LocalFree(unsafe); }
};
int refuse(const char* stage) { std::fprintf(stderr, "Owned artifact proof refused at %s (%lu).\n", stage, GetLastError()); return 2; }
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 5 || std::wcscmp(argv[2], L"artifact") || std::wcscmp(argv[3], L"scan") || std::wcscmp(argv[4], L"owned")) return 2;
  std::atomic<bool> cancelled = false; size_t scanned = 0;
  const ULONGLONG began = GetTickCount64();
  auto package = admit_desktop_artifact(argv[1], began + 20000, cancelled, scanned);
  std::printf("{\"actualPackageArtifactAccepted\":%s,\"elapsedMs\":%llu,\"scannedEntries\":%zu}\n", package ? "true" : "false", GetTickCount64() - began, scanned);
  if (!package) { diagnose_artifact(argv[1]); return refuse("actual-package-admission"); }
  package.reset();
  Fixture fixture;
  std::vector<unsigned char> user;
  LPWSTR sid = nullptr;
  if (!token_sid(GetCurrentProcess(), user) || !ConvertSidToStringSidW(user.data(), &sid)) return refuse("fixture-owner");
  const std::wstring safe = L"O:" + std::wstring(sid) + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
  const std::wstring unsafe = L"O:" + std::wstring(sid) + L"D:P(A;;FA;;;" + sid + L")(A;;FA;;;SY)(A;;GW;;;BU)";
  LocalFree(sid);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(safe.c_str(), SDDL_REVISION_1, &fixture.safe, nullptr) ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(unsafe.c_str(), SDDL_REVISION_1, &fixture.unsafe, nullptr)) return refuse("fixture-acls");
  std::vector<wchar_t> temporary(32768); const DWORD length = GetTempPathW(static_cast<DWORD>(temporary.size()), temporary.data());
  if (length == 0 || length >= temporary.size()) return refuse("fixture-temporary-root");
  std::wstring ordinary(temporary.data(), length);
  if (ordinary.compare(0, 4, L"\\\\?\\") == 0) ordinary.erase(0, 4);
  fixture.root = L"\\\\?\\" + ordinary + L"octant-artifact-qa-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), fixture.safe, FALSE};
  if (!CreateDirectoryW(fixture.root.c_str(), &attributes)) return refuse("new-fixture-root");
  fixture.created = true;
  const std::wstring image = fixture.root + L"\\Octant.exe";
  fixture.files.push_back(image);
  if (!create_file(image, fixture.safe)) return refuse("fixture-image");
  scanned = 0;
  auto baseline = admit_desktop_artifact(image, GetTickCount64() + 2500, cancelled, scanned);
  if (!baseline) return refuse("fixture-admission-control");
  baseline.reset();
  const std::wstring good = fixture.root + L"\\payload", bad = fixture.root + L"\\payload.";
  fixture.files.push_back(good); fixture.files.push_back(bad);
  if (!create_file(good, fixture.safe) || !create_file(bad, fixture.unsafe)) return refuse("exact-file-alias-pair");
  {
    Handle first(CreateFileW(good.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Handle second(CreateFileW(bad.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Handle normalized(CreateFileW(bad.substr(4).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!first || !second || !normalized || same_file(first.value, second.value) || !same_file(first.value, normalized.value)) return refuse("observed-file-normalization");
  }
  scanned = 0;
  auto refused_file = admit_desktop_artifact(image, GetTickCount64() + 2500, cancelled, scanned);
  if (refused_file) return refuse("normalized-file-cannot-hide-unsafe-acl");
  if (!DeleteFileW(bad.c_str()) || !DeleteFileW(good.c_str())) return refuse("exact-file-pair-cleanup");
  fixture.files.pop_back(); fixture.files.pop_back();
  const std::wstring good_directory = fixture.root + L"\\node", bad_directory = fixture.root + L"\\node ";
  if (!CreateDirectoryW(good_directory.c_str(), &attributes)) return refuse("safe-directory-sibling");
  fixture.directories.push_back(good_directory);
  if (!CreateDirectoryW(bad_directory.c_str(), &attributes)) return refuse("extended-directory-sibling");
  fixture.directories.push_back(bad_directory);
  const std::wstring leaf = bad_directory + L"\\unsafe.js"; fixture.files.push_back(leaf);
  if (!create_file(leaf, fixture.unsafe)) return refuse("unsafe-hidden-subtree");
  {
    Handle first = open_directory(good_directory), second = open_directory(bad_directory), normalized = open_directory(bad_directory.substr(4));
    if (!first || !second || !normalized || same_file(first.value, second.value) || !same_file(first.value, normalized.value)) return refuse("observed-directory-normalization");
  }
  scanned = 0;
  auto refused_directory = admit_desktop_artifact(image, GetTickCount64() + 2500, cancelled, scanned);
  if (refused_directory) return refuse("normalized-directory-cannot-hide-unsafe-subtree");
  std::puts("{\"ordinaryDosOpenAliasesSafeSibling\":true,\"extendedFileIdentityDistinct\":true,\"unsafeTrailingDotFileRefused\":true,\"unsafeTrailingSpaceSubtreeRefused\":true,\"fixtureImagesNeverExecuted\":true}");
  return fixture.finish() ? 0 : 2;
}
