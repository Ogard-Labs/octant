#pragma once

// Closed Windows desktop artifact admission. This header uses the owning native
// binding's Handle, token_sid and open_directory primitives; it exposes no path
// or ACL authority to JavaScript.
struct DesktopArtifact {
  std::vector<Handle> directories;
  Handle image;
  std::wstring path;
  FILE_ID_INFO identity{};
  size_t entries = 0;
};
struct DesktopArtifactTrust {
  std::vector<std::vector<unsigned char>> writers;
  bool accepts(PSID sid) const {
    if (!sid || !IsValidSid(sid)) return false;
    for (const auto& allowed : writers)
      if (EqualSid(sid, const_cast<unsigned char*>(allowed.data()))) return true;
    return false;
  }
};
bool desktop_artifact_current(ULONGLONG deadline, const std::atomic<bool>& cancelled) {
  return !cancelled && GetTickCount64() < deadline;
}
bool desktop_artifact_trust(DesktopArtifactTrust& trust) {
  std::vector<unsigned char> user;
  if (!token_sid(GetCurrentProcess(), user)) return false;
  trust.writers.push_back(std::move(user));
  for (WELL_KNOWN_SID_TYPE type : {WinLocalSystemSid, WinBuiltinAdministratorsSid}) {
    std::vector<unsigned char> sid(SECURITY_MAX_SID_SIZE); DWORD size = static_cast<DWORD>(sid.size());
    if (!CreateWellKnownSid(type, nullptr, sid.data(), &size)) return false;
    sid.resize(size); trust.writers.push_back(std::move(sid));
  }
  DWORD size = 0, domain_size = 0; SID_NAME_USE use{};
  LookupAccountNameW(nullptr, L"NT SERVICE\\TrustedInstaller", nullptr, &size, nullptr, &domain_size, &use);
  if (size == 0 || size > SECURITY_MAX_SID_SIZE || domain_size == 0 || domain_size > 256) return false;
  std::vector<unsigned char> installer(size); std::vector<wchar_t> domain(domain_size);
  if (!LookupAccountNameW(nullptr, L"NT SERVICE\\TrustedInstaller", installer.data(), &size, domain.data(), &domain_size, &use) || !IsValidSid(installer.data())) return false;
  installer.resize(size); trust.writers.push_back(std::move(installer));
  return true;
}
bool desktop_artifact_acl(HANDLE object, const DesktopArtifactTrust& trust, bool directory, bool ancestor) {
  PSID artifact_owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(object, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &artifact_owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  bool sound = trust.accepts(artifact_owner) && acl && IsValidAcl(acl);
  const DWORD mutations = WRITE_DAC | WRITE_OWNER | ACCESS_SYSTEM_SECURITY | DELETE | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA |
    (directory ? FILE_DELETE_CHILD | (ancestor ? 0 : FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY) : FILE_WRITE_DATA | FILE_APPEND_DATA);
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  for (DWORD index = 0; sound && index < acl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(acl, index, &raw)) { sound = false; break; }
    const auto header = static_cast<const ACE_HEADER*>(raw);
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    if ((header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) || header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) { sound = false; break; }
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    const PSID sid = const_cast<DWORD*>(&ace->SidStart);
    const size_t offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
    if (header->AceSize < offset + 8 || !IsValidSid(sid) || GetLengthSid(sid) > header->AceSize - offset) { sound = false; break; }
    DWORD mask = ace->Mask; MapGenericMask(&mask, &mapping);
    if ((mask & ~(FILE_ALL_ACCESS | ACCESS_SYSTEM_SECURITY)) != 0) { sound = false; break; }
    // Denies never grant authority. Conservative inspection of allows does not
    // rely on a particular group-membership or deny ordering to admit writers.
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && (mask & mutations) != 0 && !trust.accepts(sid)) sound = false;
  }
  if (descriptor) LocalFree(descriptor);
  return sound;
}
bool desktop_artifact_file(HANDLE file, const DesktopArtifactTrust& trust) {
  BY_HANDLE_FILE_INFORMATION facts{};
  return GetFileType(file) == FILE_TYPE_DISK && GetFileInformationByHandle(file, &facts) && facts.nNumberOfLinks == 1 &&
    (facts.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 && desktop_artifact_acl(file, trust, false, false);
}
bool desktop_artifact_component(const std::wstring& name) {
  if (name.empty() || name.size() > 255 || name.back() == L'.' || name.back() == L' ') return false;
  for (wchar_t character : name)
    if (character < 32 || std::wcschr(L"<>:\"/\\|?*", character)) return false;
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name.data(), static_cast<int>(name.size()), nullptr, 0, nullptr, nullptr) <= 0) return false;
  std::wstring base = name.substr(0, name.find(L'.'));
  while (!base.empty() && base.back() == L' ') base.pop_back();
  for (const wchar_t* reserved : {L"CON", L"PRN", L"AUX", L"NUL", L"CONIN$", L"CONOUT$", L"CLOCK$"})
    if (_wcsicmp(base.c_str(), reserved) == 0) return false;
  if (base.size() == 4 && (_wcsnicmp(base.c_str(), L"COM", 3) == 0 || _wcsnicmp(base.c_str(), L"LPT", 3) == 0)) {
    const wchar_t digit = base[3];
    if ((digit >= L'1' && digit <= L'9') || digit == 0x00b9 || digit == 0x00b2 || digit == 0x00b3) return false;
  }
  return true;
}
bool desktop_artifact_tree(DesktopArtifact& artifact, const DesktopArtifactTrust& trust,
    const std::wstring& directory, size_t depth, ULONGLONG deadline, const std::atomic<bool>& cancelled) {
  if (depth > 32 || ++artifact.entries > 100000 || !desktop_artifact_current(deadline, cancelled)) return false;
  Handle held = open_directory(directory);
  if (!held || !desktop_artifact_acl(held.value, trust, true, false)) return false;
  artifact.directories.push_back(std::move(held));
  WIN32_FIND_DATAW item{};
  const std::wstring pattern = directory + L"\\*";
  HANDLE search = FindFirstFileW(pattern.c_str(), &item);
  if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  struct FindCleanup { HANDLE value; ~FindCleanup() { FindClose(value); } } cleanup{search};
  for (;;) {
    if (std::wcscmp(item.cFileName, L".") != 0 && std::wcscmp(item.cFileName, L"..") != 0) {
      if (!desktop_artifact_component(item.cFileName) || (item.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || !desktop_artifact_current(deadline, cancelled)) return false;
      const std::wstring path = directory + L"\\" + item.cFileName;
      if (path.size() >= 32768) return false;
      if ((item.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        if (!desktop_artifact_tree(artifact, trust, path, depth + 1, deadline, cancelled)) return false;
      } else {
        if (++artifact.entries > 100000) return false;
        Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
          nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!file || !desktop_artifact_file(file.value, trust)) return false;
      }
    }
    if (!FindNextFileW(search, &item)) return GetLastError() == ERROR_NO_MORE_FILES;
  }
}
bool desktop_image_path(const std::wstring& path, std::wstring& ordinary) {
  ordinary = path;
  if (ordinary.compare(0, 4, L"\\\\?\\") == 0) ordinary.erase(0, 4);
  if (ordinary.size() < 4 || ordinary.size() >= 32768 || ordinary[1] != L':' || ordinary[2] != L'\\' ||
      !((ordinary[0] >= L'A' && ordinary[0] <= L'Z') || (ordinary[0] >= L'a' && ordinary[0] <= L'z'))) return false;
  for (size_t index = 0; index < ordinary.size(); ++index)
    if (ordinary[index] < 32 || ordinary[index] == L'/' || ordinary[index] == L'"' || (ordinary[index] == L':' && index != 1)) return false;
  const size_t separator = ordinary.find_last_of(L'\\');
  return separator != std::wstring::npos && _wcsicmp(ordinary.c_str() + separator + 1, L"Octant.exe") == 0 &&
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, ordinary.data(), static_cast<int>(ordinary.size()), nullptr, 0, nullptr, nullptr) > 0;
}
std::unique_ptr<DesktopArtifact> admit_desktop_artifact(const std::wstring& image, ULONGLONG deadline, const std::atomic<bool>& cancelled, size_t& scanned) {
  std::wstring ordinary;
  if (!desktop_image_path(image, ordinary) || !desktop_artifact_current(deadline, cancelled)) return nullptr;
  const std::wstring drive = ordinary.substr(0, 3);
  const UINT type = GetDriveTypeW(drive.c_str());
  if (type != DRIVE_FIXED && type != DRIVE_REMOVABLE) return nullptr;
  DesktopArtifactTrust trust;
  if (!desktop_artifact_trust(trust)) return nullptr;
  auto artifact = std::make_unique<DesktopArtifact>();
  struct ScannedEntries { size_t& result; const DesktopArtifact& artifact; ~ScannedEntries() { result = artifact.entries; } } receipt{scanned, *artifact};
  const size_t leaf = ordinary.find_last_of(L'\\');
  std::wstring current = drive;
  Handle root = open_directory(current);
  if (!root || !desktop_artifact_acl(root.value, trust, true, true)) return nullptr;
  artifact->directories.push_back(std::move(root));
  size_t start = 3;
  while (start < leaf) {
    const size_t next = ordinary.find(L'\\', start);
    if (next == std::wstring::npos || next > leaf || next == start) return nullptr;
    const std::wstring component = ordinary.substr(start, next - start);
    if (!desktop_artifact_component(component)) return nullptr;
    if (current.back() != L'\\') current += L'\\'; current += component;
    if (next == leaf) break;
    Handle directory = open_directory(current);
    if (!directory || !desktop_artifact_acl(directory.value, trust, true, true)) return nullptr;
    artifact->directories.push_back(std::move(directory));
    if (!desktop_artifact_current(deadline, cancelled)) return nullptr;
    start = next + 1;
  }
  artifact->image = Handle(CreateFileW(ordinary.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!artifact->image || !desktop_artifact_file(artifact->image.value, trust) ||
      !GetFileInformationByHandleEx(artifact->image.value, FileIdInfo, &artifact->identity, sizeof(artifact->identity))) return nullptr;
  std::vector<wchar_t> path(32768);
  const DWORD length = GetFinalPathNameByHandleW(artifact->image.value, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length >= path.size()) return nullptr;
  artifact->path.assign(path.data(), length);
  std::wstring canonical;
  if (!desktop_image_path(artifact->path, canonical) || _wcsicmp(canonical.c_str(), ordinary.c_str()) != 0 ||
      !desktop_artifact_tree(*artifact, trust, current, 0, deadline, cancelled)) return nullptr;
  return artifact;
}
