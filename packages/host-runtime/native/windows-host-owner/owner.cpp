#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <bcrypt.h>
#include <delayimp.h>
#include <node_api.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <cwchar>
#include <map>
#include <memory>
#include <string>
#include <vector>

// The stable Node-API imports belong to whichever supported runtime loaded
// this module, including Electron and Bun; no separate node.exe is launched.
static FARPROC WINAPI load_runtime(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
  return nullptr;
}
extern "C" const PfnDliHook __pfnDliNotifyHook2 = load_runtime;

namespace {
constexpr DWORD frame_limit = 16384;
constexpr DWORD receipt_limit = 4096;
constexpr ULONGLONG io_bound = 2000;
constexpr size_t record_head = 56;
const std::array<unsigned char, 8> record_magic{'O','C','T','O','W','N','0','1'};
SRWLOCK lock = SRWLOCK_INIT;
struct Guard {
  Guard() { AcquireSRWLockExclusive(&lock); }
  ~Guard() { ReleaseSRWLockExclusive(&lock); }
};
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { reset(); value = other.value; other.value = INVALID_HANDLE_VALUE; }
    return *this;
  }
  ~Handle() { reset(); }
  void reset() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
  explicit operator bool() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
};
struct Bytes : std::vector<unsigned char> {
  ~Bytes() { if (!empty()) SecureZeroMemory(data(), size()); }
};
struct Identity { DWORD pid = 0; FILETIME born{}; };
struct Record { Identity identity; Bytes secret; Bytes receipt; };
struct Root {
  std::vector<Handle> ancestors;
  std::wstring path, display_path, endpoint, sid;
  std::vector<unsigned char> sid_bytes;
  PSECURITY_DESCRIPTOR security = nullptr;
  PSECURITY_DESCRIPTOR directory_security = nullptr;
  ~Root() {
    if (security != nullptr) LocalFree(security);
    if (directory_security != nullptr) LocalFree(directory_security);
  }
};
struct Owner {
  napi_env env = nullptr;
  std::string scope;
  std::unique_ptr<Root> root;
  Handle pipe, record;
  bool connected = false, awaiting_reply = false, response_sent = false;
  unsigned connection = 0;
  ULONGLONG connected_at = 0;
  Bytes incoming, outgoing;
  size_t written = 0;
};
struct Client {
  napi_env env = nullptr;
  std::unique_ptr<Root> root;
  Handle pipe;
  Identity server;
  Bytes incoming, outgoing;
  size_t written = 0;
  ULONGLONG started = 0;
};
struct AdmissionGuard { std::unique_ptr<Root> root; Handle record; };
struct Profile { std::unique_ptr<Root> root; Handle identity; std::string scope; };
std::map<std::string, std::unique_ptr<Profile>> profiles;
std::vector<AdmissionGuard> admitted;
std::unique_ptr<Owner> owner;
char module_identity;
bool pin_module() {
  HMODULE module = nullptr;
  return GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
    reinterpret_cast<LPCWSTR>(&module_identity), &module) != FALSE;
}
void retire_owner() {
  if (owner && owner->record) admitted.push_back({std::move(owner->root), std::move(owner->record)});
  owner.reset();
}
std::map<unsigned, std::unique_ptr<Client>> clients;
unsigned next_client = 1;

napi_value text(napi_env env, const char* value) { napi_value result; napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result); return result; }
napi_value object(napi_env env, const char* status) { napi_value result; napi_create_object(env, &result); napi_set_named_property(env, result, "status", text(env, status)); return result; }
void put(napi_env env, napi_value out, const char* key, const std::string& value) { napi_value encoded; napi_create_string_utf8(env, value.data(), value.size(), &encoded); napi_set_named_property(env, out, key, encoded); }
void number(napi_env env, napi_value out, const char* key, unsigned value) { napi_value encoded; napi_create_uint32(env, value, &encoded); napi_set_named_property(env, out, key, encoded); }
void buffer(napi_env env, napi_value out, const char* key, const std::vector<unsigned char>& bytes) { napi_value encoded; void* copied = nullptr; napi_create_buffer_copy(env, bytes.size(), bytes.data(), &copied, &encoded); napi_set_named_property(env, out, key, encoded); }
std::string string_arg(napi_env env, napi_value input) {
  napi_valuetype type;
  if (napi_typeof(env, input, &type) != napi_ok || type != napi_string) return {};
  size_t size = 0;
  if (napi_get_value_string_utf8(env, input, nullptr, 0, &size) != napi_ok || size > receipt_limit) return {};
  std::vector<char> bytes(size + 1);
  if (napi_get_value_string_utf8(env, input, bytes.data(), bytes.size(), &size) != napi_ok) return {};
  return std::string(bytes.data(), size);
}
bool byte_arg(napi_env env, napi_value input, Bytes& result, size_t maximum) {
  bool is_buffer = false;
  void* data = nullptr; size_t size = 0;
  if (napi_is_buffer(env, input, &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, input, &data, &size) != napi_ok || size > maximum) return false;
  const auto begin = static_cast<unsigned char*>(data);
  if (size == 0) result.clear(); else result.assign(begin, begin + size); return true;
}
bool uuid(const std::string& value) {
  if (value.size() != 36) return false;
  for (size_t i = 0; i < value.size(); ++i) {
    const char c = value[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}
std::string birth(const FILETIME& time) {
  char value[17]; sprintf_s(value, "%08lx%08lx", time.dwHighDateTime, time.dwLowDateTime); return std::string("win32:") + value;
}
bool process_identity(HANDLE process, Identity& result) {
  FILETIME exited, kernel, user;
  return GetProcessTimes(process, &result.born, &exited, &kernel, &user) != FALSE;
}
bool current_identity(Identity& result) { result.pid = GetCurrentProcessId(); return process_identity(GetCurrentProcess(), result); }
// Unknown is never evidence that a recorded writer is dead.
int alive(const Identity& recorded) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, recorded.pid));
  if (!process) return GetLastError() == ERROR_INVALID_PARAMETER ? 0 : -1;
  if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) return 0;
  Identity observed;
  if (!process_identity(process.value, observed)) return -1;
  return CompareFileTime(&observed.born, &recorded.born) == 0 ? 1 : 0;
}
bool token_sid(HANDLE process, std::vector<unsigned char>& output, std::wstring* label = nullptr) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return false;
  Handle token(raw); DWORD needed = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &needed);
  if (needed == 0 || needed > 65536) return false;
  std::vector<unsigned char> memory(needed);
  if (!GetTokenInformation(token.value, TokenUser, memory.data(), needed, &needed)) return false;
  const auto user = reinterpret_cast<const TOKEN_USER*>(memory.data());
  const DWORD length = GetLengthSid(user->User.Sid);
  output.resize(length);
  if (!CopySid(length, output.data(), user->User.Sid)) return false;
  if (label != nullptr) {
    LPWSTR encoded = nullptr;
    if (!ConvertSidToStringSidW(user->User.Sid, &encoded)) return false;
    *label = encoded; LocalFree(encoded);
  }
  return true;
}
bool same_user(DWORD pid, const Root& root) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  std::vector<unsigned char> sid;
  return process && token_sid(process.value, sid) && EqualSid(sid.data(), const_cast<unsigned char*>(root.sid_bytes.data()));
}
bool private_acl(HANDLE handle, const Root& root, BYTE expected_flags = 0, bool protected_dacl = true) {
  PSID principal = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &principal, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  std::array<unsigned char, SECURITY_MAX_SID_SIZE> system{}; DWORD system_size = static_cast<DWORD>(system.size());
  bool sound = principal != nullptr && IsValidSid(principal) && EqualSid(principal, const_cast<unsigned char*>(root.sid_bytes.data())) && acl != nullptr && acl->AceCount == 2 &&
    GetSecurityDescriptorControl(descriptor, &control, &revision) && ((control & SE_DACL_PROTECTED) != 0) == protected_dacl &&
    CreateWellKnownSid(WinLocalSystemSid, nullptr, system.data(), &system_size);
  bool saw_user = false, saw_system = false;
  for (DWORD i = 0; sound && i < acl->AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(acl, i, &raw)) { sound = false; break; }
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceSize < sizeof(ACCESS_ALLOWED_ACE) || ace->Header.AceFlags != expected_flags || ace->Mask != FILE_ALL_ACCESS) { sound = false; break; }
    const auto sid = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(sid)) { sound = false; break; }
    if (EqualSid(sid, const_cast<unsigned char*>(root.sid_bytes.data())) && !saw_user) saw_user = true;
    else if (EqualSid(sid, system.data()) && !saw_system) saw_system = true;
    else sound = false;
  }
  LocalFree(descriptor); return sound && saw_user && saw_system;
}
Handle open_directory(const std::wstring& path) {
  // Metadata-only opens do not participate in share-access checks. The real
  // data-directory rename probe requires a read/list right to hold its name.
  Handle handle(CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!handle || !GetFileInformationByHandleEx(handle.value, FileAttributeTagInfo, &info, sizeof(info)) ||
      (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Handle();
  return handle;
}
std::unique_ptr<Root> private_root(const std::vector<std::wstring>& components, bool create, bool inherit) {
  auto result = std::make_unique<Root>();
  if (!token_sid(GetCurrentProcess(), result->sid_bytes, &result->sid)) return nullptr;
  const std::wstring security = L"O:" + result->sid + L"D:P(A;;FA;;;" + result->sid + L")(A;;FA;;;SY)";
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(security.c_str(), SDDL_REVISION_1, &result->security, nullptr)) return nullptr;
  if (inherit) {
    const std::wstring directories = L"O:" + result->sid + L"D:P(A;OICI;FA;;;" + result->sid + L")(A;OICI;FA;;;SY)";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(directories.c_str(), SDDL_REVISION_1, &result->directory_security, nullptr)) return nullptr;
  }
  PWSTR local = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &local))) return nullptr;
  std::wstring base(local); CoTaskMemFree(local);
  if (base.size() < 3 || base[1] != L':' || base[2] != L'\\') return nullptr;
  if (GetDriveTypeW(base.substr(0, 3).c_str()) != DRIVE_FIXED) return nullptr;
  // Retained handles omit FILE_SHARE_DELETE: none of the proven ancestors
  // can be renamed or replaced while this runtime is admitted.
  for (size_t end = 3;;) {
    const size_t separator = base.find(L'\\', end);
    const std::wstring path = separator == std::wstring::npos ? base : base.substr(0, separator);
    Handle handle = open_directory(path);
    if (!handle) return nullptr;
    result->ancestors.push_back(std::move(handle));
    if (separator == std::wstring::npos) break;
    end = separator + 1;
  }
  std::wstring path = base;
  std::vector<std::wstring> segments{L"Octant"};
  segments.insert(segments.end(), components.begin(), components.end());
  size_t index = 0;
  for (const std::wstring& component : segments) {
    const bool inherited_directory = inherit && index++ > 0;
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), inherited_directory ? result->directory_security : result->security, FALSE};
    path += L"\\" + component;
    if (create && !CreateDirectoryW(path.c_str(), &attributes) && GetLastError() != ERROR_ALREADY_EXISTS) return nullptr;
    Handle handle = open_directory(path);
    const BYTE flags = inherited_directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
    if (!handle || !private_acl(handle.value, *result, flags)) return nullptr;
    result->ancestors.push_back(std::move(handle));
  }
  std::vector<wchar_t> canonical(32768);
  const DWORD canonical_size = GetFinalPathNameByHandleW(result->ancestors.back().value,
    canonical.data(), static_cast<DWORD>(canonical.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (canonical_size == 0 || canonical_size >= canonical.size()) return nullptr;
  result->display_path.assign(canonical.data(), canonical_size);
  const DWORD physical_size = GetFinalPathNameByHandleW(result->ancestors.back().value,
    canonical.data(), static_cast<DWORD>(canonical.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (physical_size == 0 || physical_size >= canonical.size()) return nullptr;
  result->path.assign(canonical.data(), physical_size);
  return result;
}
std::unique_ptr<Root> root_for(const std::string& scope, bool create) {
  if (!uuid(scope)) return nullptr;
  auto result = private_root({L"runtime", std::wstring(scope.begin(), scope.end())}, create, false);
  if (!result) return nullptr;
  std::vector<unsigned char> input(result->sid_bytes);
  input.insert(input.end(), scope.begin(), scope.end());
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  std::array<unsigned char, 32> digest{};
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return nullptr;
  const bool hashed = BCryptHash(algorithm, nullptr, 0, input.data(), static_cast<ULONG>(input.size()), digest.data(), static_cast<ULONG>(digest.size())) >= 0;
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!hashed) return nullptr;
  result->endpoint = L"\\\\.\\pipe\\Octant-host-";
  const wchar_t* hex = L"0123456789abcdef";
  for (const auto value : digest) { result->endpoint += hex[value >> 4]; result->endpoint += hex[value & 15]; }
  return result;
}
DWORD u32(const unsigned char* data) { return static_cast<DWORD>(data[0]) | (static_cast<DWORD>(data[1]) << 8) | (static_cast<DWORD>(data[2]) << 16) | (static_cast<DWORD>(data[3]) << 24); }
void write_u32(unsigned char* data, DWORD value) { for (unsigned i = 0; i < 4; ++i) data[i] = static_cast<unsigned char>((value >> (8 * i)) & 255); }
// 0 missing, 1 sound, -1 unsafe/unreadable. A failed read never means absence.
int read_record(const Root& root, Record& record) {
  const std::wstring path = root.path + L"\\owner.bin";
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file) return GetLastError() == ERROR_FILE_NOT_FOUND ? 0 : -1;
  BY_HANDLE_FILE_INFORMATION info{};
  LARGE_INTEGER size{};
  if (!GetFileInformationByHandle(file.value, &info) || info.nNumberOfLinks != 1 ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !private_acl(file.value, root) || !GetFileSizeEx(file.value, &size) || size.QuadPart < static_cast<LONGLONG>(record_head) || size.QuadPart > static_cast<LONGLONG>(record_head + receipt_limit)) return -1;
  Bytes bytes; bytes.resize(static_cast<size_t>(size.QuadPart)); DWORD got = 0;
  if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &got, nullptr) || got != bytes.size() ||
      !std::equal(record_magic.begin(), record_magic.end(), bytes.begin()) || u32(bytes.data() + 20) != bytes.size() - record_head) return -1;
  record.identity.pid = u32(bytes.data() + 8);
  record.identity.born.dwLowDateTime = u32(bytes.data() + 12);
  record.identity.born.dwHighDateTime = u32(bytes.data() + 16);
  if (record.identity.pid == 0 || (record.identity.born.dwLowDateTime == 0 && record.identity.born.dwHighDateTime == 0)) return -1;
  record.secret.assign(bytes.begin() + 24, bytes.begin() + 56);
  record.receipt.assign(bytes.begin() + record_head, bytes.end()); return 1;
}
Handle persist(const Root& root, const Bytes& receipt, const Bytes& secret, const Identity& identity) {
  const std::wstring path = root.path + L"\\owner.bin";
  // Only a verified dead owner may be replaced. Deletion applies to the
  // inspected file handle, never to a later pathname replacement.
  Handle old(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL | DELETE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (old) {
    BY_HANDLE_FILE_INFORMATION info{}; FILE_DISPOSITION_INFO remove{TRUE};
    if (!private_acl(old.value, root) || !GetFileInformationByHandle(old.value, &info) || info.nNumberOfLinks != 1 ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        !SetFileInformationByHandle(old.value, FileDispositionInfo, &remove, sizeof(remove))) return Handle();
    old.reset();
  } else if (GetLastError() != ERROR_FILE_NOT_FOUND) return Handle();
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), root.security, FALSE};
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    FILE_SHARE_READ, &attributes, CREATE_NEW, FILE_FLAG_WRITE_THROUGH, nullptr));
  if (!file || !private_acl(file.value, root)) return Handle();
  Bytes bytes; bytes.resize(record_head + receipt.size());
  std::copy(record_magic.begin(), record_magic.end(), bytes.begin());
  write_u32(bytes.data() + 8, identity.pid); write_u32(bytes.data() + 12, identity.born.dwLowDateTime); write_u32(bytes.data() + 16, identity.born.dwHighDateTime);
  write_u32(bytes.data() + 20, static_cast<DWORD>(receipt.size()));
  std::copy(secret.begin(), secret.end(), bytes.begin() + 24); std::copy(receipt.begin(), receipt.end(), bytes.begin() + record_head);
  DWORD wrote = 0;
  if (!WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &wrote, nullptr) || wrote != bytes.size() || !FlushFileBuffers(file.value)) return Handle();
  return file;
}
std::string utf8(const std::wstring& value) {
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr); return result;
}
constexpr BYTE directory_inheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
constexpr size_t profile_record_size = 73;
constexpr size_t profile_scope_offset = profile_record_size - 16;
const std::array<unsigned char, 8> profile_magic{'O','C','T','P','R','O','0','1'};
std::string profile_scope(const unsigned char* bytes) {
  if ((bytes[6] & 0xf0) != 0x40 || (bytes[8] & 0xc0) != 0x80) return {};
  const char* hex = "0123456789abcdef";
  std::string result;
  for (size_t i = 0; i < 16; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) result += '-';
    result += hex[bytes[i] >> 4]; result += hex[bytes[i] & 15];
  }
  return result;
}
bool profile_directory(Root& root, const wchar_t* name) {
  const std::wstring path = root.path + L"\\" + name;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), root.directory_security, FALSE};
  if (!CreateDirectoryW(path.c_str(), &attributes) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
  Handle directory = open_directory(path);
  if (!directory || !private_acl(directory.value, root, directory_inheritance)) return false;
  root.ancestors.push_back(std::move(directory)); return true;
}
Handle profile_identity(const Root& root, unsigned char kind, const std::array<FILE_ID_INFO, 2>& directories, std::string& scope) {
  const std::wstring path = root.path + L"\\profile.bin";
  // This file is metadata, not a signing key. Its explicit protected ACL is
  // independent of the inheritable ACL used by ordinary persistent data.
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  std::string created_scope;
  if (!file) {
    if (GetLastError() != ERROR_FILE_NOT_FOUND) return Handle();
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), root.security, FALSE};
    Handle created(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
      FILE_SHARE_READ, &attributes, CREATE_NEW, FILE_FLAG_WRITE_THROUGH, nullptr));
    if (!created || !private_acl(created.value, root)) return Handle();
    std::array<unsigned char, profile_record_size> encoded{};
    std::copy(profile_magic.begin(), profile_magic.end(), encoded.begin()); encoded[8] = kind;
    for (size_t i = 0; i < directories.size(); ++i) {
      std::memcpy(encoded.data() + 9 + i * 24, &directories[i].VolumeSerialNumber, 8);
      std::memcpy(encoded.data() + 17 + i * 24, directories[i].FileId.Identifier, 16);
    }
    if (BCryptGenRandom(nullptr, encoded.data() + profile_scope_offset, 16, BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return Handle();
    encoded[profile_scope_offset + 6] = static_cast<unsigned char>((encoded[profile_scope_offset + 6] & 15) | 0x40);
    encoded[profile_scope_offset + 8] = static_cast<unsigned char>((encoded[profile_scope_offset + 8] & 63) | 0x80);
    created_scope = profile_scope(encoded.data() + profile_scope_offset);
    DWORD wrote = 0;
    if (!WriteFile(created.value, encoded.data(), static_cast<DWORD>(encoded.size()), &wrote, nullptr) ||
        wrote != encoded.size() || !FlushFileBuffers(created.value)) return Handle();
    created.reset();
    file = Handle(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  }
  BY_HANDLE_FILE_INFORMATION metadata{}; LARGE_INTEGER size{};
  if (!file || !private_acl(file.value, root) || !GetFileInformationByHandle(file.value, &metadata) ||
      metadata.nNumberOfLinks != 1 || (metadata.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !GetFileSizeEx(file.value, &size) || size.QuadPart != static_cast<LONGLONG>(profile_record_size)) return Handle();
  std::array<unsigned char, profile_record_size> encoded{}; DWORD got = 0;
  if (!ReadFile(file.value, encoded.data(), static_cast<DWORD>(encoded.size()), &got, nullptr) || got != encoded.size() ||
      !std::equal(profile_magic.begin(), profile_magic.end(), encoded.begin()) || encoded[8] != kind) return Handle();
  for (size_t i = 0; i < directories.size(); ++i)
    if (std::memcmp(encoded.data() + 9 + i * 24, &directories[i].VolumeSerialNumber, 8) != 0 ||
        std::memcmp(encoded.data() + 17 + i * 24, directories[i].FileId.Identifier, 16) != 0) return Handle();
  scope = profile_scope(encoded.data() + profile_scope_offset);
  if (scope.empty() || (!created_scope.empty() && scope != created_scope)) return Handle();
  return file;
}
napi_value open_profile(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 1; napi_value arguments[1]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  if (count != 1) return object(env, "refused");
  const std::string name = string_arg(env, arguments[0]);
  const unsigned char kind = name == "octant" ? 1 : name == "nightly-test-data" ? 2 : 0;
  if (kind == 0) return object(env, "refused");
  auto profile = std::make_unique<Profile>();
  profile->root = private_root({L"hosts", std::wstring(name.begin(), name.end())}, true, true);
  if (!profile->root) return object(env, "refused");
  std::array<FILE_ID_INFO, 2> directories{};
  if (!GetFileInformationByHandleEx(profile->root->ancestors.back().value, FileIdInfo, &directories[0], sizeof(FILE_ID_INFO))) return object(env, "refused");
  for (const wchar_t* child : {L"data", L"config", L"state", L"logs"}) {
    if (!profile_directory(*profile->root, child)) return object(env, "refused");
    if (std::wcscmp(child, L"data") == 0 && !GetFileInformationByHandleEx(profile->root->ancestors.back().value, FileIdInfo, &directories[1], sizeof(FILE_ID_INFO))) return object(env, "refused");
  }
  profile->identity = profile_identity(*profile->root, kind, directories, profile->scope);
  if (!profile->identity) return object(env, "refused");
  const auto existing = profiles.find(name);
  if (existing != profiles.end() && existing->second->scope != profile->scope) return object(env, "refused");
  if (!pin_module()) return object(env, "refused");
  napi_value result = object(env, "ready");
  put(env, result, "profile", name); put(env, result, "profileId", profile->scope);
  put(env, result, "rootDirectory", utf8(profile->root->display_path));
  for (const auto& child : {std::pair<const char*, const wchar_t*>{"dataDirectory", L"data"}, {"configDirectory", L"config"}, {"stateDirectory", L"state"}, {"logsDirectory", L"logs"}})
    put(env, result, child.first, utf8(profile->root->display_path + L"\\" + child.second));
  if (existing == profiles.end()) profiles.emplace(name, std::move(profile));
  // Persistent writers may outlive their control connection or environment.
  // Native guards and the identity handle remain until this process exits.
  return result;
}
void record_fields(napi_env env, napi_value result, const Record& record) {
  number(env, result, "pid", record.identity.pid); put(env, result, "processStart", birth(record.identity.born));
  buffer(env, result, "secret", record.secret); buffer(env, result, "receipt", record.receipt);
}
void reset_connection(Owner& state) {
  DisconnectNamedPipe(state.pipe.value);
  state.connected = false; state.awaiting_reply = false; state.response_sent = false;
  if (!state.incoming.empty()) SecureZeroMemory(state.incoming.data(), state.incoming.size());
  if (!state.outgoing.empty()) SecureZeroMemory(state.outgoing.data(), state.outgoing.size()); state.incoming.clear(); state.outgoing.clear(); state.written = 0;
}
void cleanup_env(void* input) {
  const auto env = static_cast<napi_env>(input); Guard guard;
  if (owner && owner->env == env) retire_owner();
  for (auto it = clients.begin(); it != clients.end();) { if (it->second->env == env) it = clients.erase(it); else ++it; }
  // The native-computed PID/birth record intentionally survives handle or
  // environment loss. A live or unverifiable writer is never taken over.
}
napi_value prepare(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 1; napi_value arguments[1]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  if (count != 1) return object(env, "refused");
  const std::string scope = string_arg(env, arguments[0]);
  if (!uuid(scope) || owner || admitted.size() >= 16) return object(env, "refused");
  auto root = root_for(scope, true); Identity identity;
  if (!root || !current_identity(identity)) return object(env, "refused");
  owner = std::make_unique<Owner>(); owner->root = std::move(root); owner->scope = scope; owner->env = env;
  napi_value result = object(env, "prepared");
  number(env, result, "pid", identity.pid); put(env, result, "processStart", birth(identity.born));
  put(env, result, "endpoint", utf8(owner->root->endpoint)); put(env, result, "runtimeDirectory", utf8(owner->root->display_path)); return result;
}
napi_value claim(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 2; napi_value arguments[2]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  Bytes receipt, secret;
  if (count != 2 || !owner || owner->env != env || owner->pipe || !byte_arg(env, arguments[0], receipt, receipt_limit) || receipt.empty() ||
      !byte_arg(env, arguments[1], secret, 32) || secret.size() != 32) return object(env, "refused");
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), owner->root->security, FALSE};
  Handle pipe(CreateNamedPipeW(owner->root->endpoint.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, frame_limit + 1, frame_limit + 1, 0, &attributes));
  // A competing pipe is not proof of a usable owner. Only a matching private
  // PID/birth record followed by an authenticated exchange can attach.
  Record previous;
  const int found = read_record(*owner->root, previous);
  if (found < 0) return object(env, "refused");
  if (found == 1) {
    const int status = alive(previous.identity);
    if (status != 0) {
      napi_value result = object(env, status == 1 ? "existing" : "unknown");
      if (status == 1) record_fields(env, result, previous);
      return result;
    }
  }
  if (!pipe || !private_acl(pipe.value, *owner->root)) return object(env, "refused");
  Identity identity;
  if (!current_identity(identity)) return object(env, "refused");
  if (!pin_module()) return object(env, "refused");
  Handle record = persist(*owner->root, receipt, secret, identity);
  if (!record) return object(env, "refused");
  owner->pipe = std::move(pipe); owner->record = std::move(record);
  return object(env, "owned");
}
napi_value lookup(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 1; napi_value arguments[1]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  if (count != 1) return object(env, "refused");
  auto root = root_for(string_arg(env, arguments[0]), false);
  if (!root) return object(env, "refused");
  Record record; const int found = read_record(*root, record);
  if (found != 1) return object(env, found == 0 ? "missing" : "refused");
  const int status = alive(record.identity);
  napi_value result = object(env, status == 1 ? "existing" : status == 0 ? "dead" : "unknown");
  if (status == 1) record_fields(env, result, record);
  return result;
}
napi_value poll(napi_env env, napi_callback_info) {
  Guard guard;
  if (!owner || owner->env != env || !owner->pipe) return object(env, "closed");
  Owner& state = *owner;
  if (!state.connected) {
    const bool connected = ConnectNamedPipe(state.pipe.value, nullptr) != FALSE;
    const DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    // A client can close before the first poll. Windows keeps that instance
    // at ERROR_NO_DATA until disconnected, otherwise every later client is busy.
    if (!connected && error == ERROR_NO_DATA) { reset_connection(state); return object(env, "idle"); }
    if (!connected && error != ERROR_PIPE_CONNECTED) return object(env, "idle");
    ULONG client = 0;
    if (!GetNamedPipeClientProcessId(state.pipe.value, &client) || !same_user(client, *state.root)) { reset_connection(state); return object(env, "idle"); }
    state.connected = true; state.connected_at = GetTickCount64(); ++state.connection;
  }
  if (GetTickCount64() - state.connected_at > io_bound) { reset_connection(state); return object(env, "idle"); }
  if (!state.outgoing.empty()) {
    DWORD wrote = 0;
    const DWORD remaining = static_cast<DWORD>(state.outgoing.size() - state.written);
    if (!WriteFile(state.pipe.value, state.outgoing.data() + state.written, remaining, &wrote, nullptr)) { reset_connection(state); return object(env, "idle"); }
    state.written += wrote;
    if (state.written == state.outgoing.size()) {
      SecureZeroMemory(state.outgoing.data(), state.outgoing.size()); state.outgoing.clear(); state.response_sent = true;
    }
    return object(env, "idle");
  }
  if (state.response_sent) {
    DWORD remaining = 0;
    if (!PeekNamedPipe(state.pipe.value, nullptr, 0, nullptr, &remaining, nullptr)) reset_connection(state);
    return object(env, "idle");
  }
  if (state.awaiting_reply) return object(env, "idle");
  DWORD available = 0;
  if (!PeekNamedPipe(state.pipe.value, nullptr, 0, nullptr, &available, nullptr)) { reset_connection(state); return object(env, "idle"); }
  if (available == 0) return object(env, "idle");
  const size_t offset = state.incoming.size();
  const DWORD wanted = std::min(available, frame_limit + 1 - static_cast<DWORD>(offset));
  state.incoming.resize(offset + wanted); DWORD got = 0;
  if (!ReadFile(state.pipe.value, state.incoming.data() + offset, wanted, &got, nullptr)) { reset_connection(state); return object(env, "idle"); }
  state.incoming.resize(offset + got);
  const auto end = std::find(state.incoming.begin(), state.incoming.end(), '\n');
  if (end != state.incoming.end()) {
    if (static_cast<size_t>(end - state.incoming.begin()) >= frame_limit) { reset_connection(state); return object(env, "idle"); }
    state.incoming.resize(static_cast<size_t>(end - state.incoming.begin()));
    state.awaiting_reply = true;
    napi_value result = object(env, "request"); number(env, result, "id", state.connection); buffer(env, result, "bytes", state.incoming); return result;
  }
  if (state.incoming.size() >= frame_limit) reset_connection(state);
  return object(env, "idle");
}
napi_value reply(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 2; napi_value arguments[2]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  unsigned id = 0; Bytes bytes;
  if (count != 2 || napi_get_value_uint32(env, arguments[0], &id) != napi_ok || !owner || owner->env != env ||
      !owner->awaiting_reply || owner->connection != id || !byte_arg(env, arguments[1], bytes, frame_limit - 1) || bytes.empty()) return object(env, "refused");
  owner->outgoing.assign(bytes.begin(), bytes.end()); owner->outgoing.push_back('\n'); owner->written = 0; owner->awaiting_reply = false;
  return object(env, "accepted");
}
napi_value close_owner(napi_env env, napi_callback_info) {
  Guard guard;
  if (owner && owner->env == env) retire_owner();
  return object(env, "closed");
}
napi_value begin_request(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 2; napi_value arguments[2]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  Bytes frame;
  if (count != 2 || clients.size() >= 8 || !byte_arg(env, arguments[1], frame, frame_limit - 1) || frame.empty()) return object(env, "refused");
  auto root = root_for(string_arg(env, arguments[0]), false);
  if (!root) return object(env, "refused");
  Record record;
  if (read_record(*root, record) != 1 || alive(record.identity) != 1) return object(env, "refused");
  // Peer identity authenticates this connection; no caller impersonation
  // authority is delegated to the server process.
  Handle pipe(CreateFileW(root->endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  if (!pipe) return object(env, GetLastError() == ERROR_PIPE_BUSY ? "busy" : "refused");
  DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT; ULONG server = 0;
  if (!SetNamedPipeHandleState(pipe.value, &mode, nullptr, nullptr) ||
      !GetNamedPipeServerProcessId(pipe.value, &server) || server != record.identity.pid || !same_user(server, *root) || alive(record.identity) != 1) return object(env, "refused");
  auto client = std::make_unique<Client>(); client->env = env; client->root = std::move(root); client->pipe = std::move(pipe);
  client->server = record.identity; client->outgoing.assign(frame.begin(), frame.end()); client->outgoing.push_back('\n'); client->started = GetTickCount64();
  const unsigned id = next_client++; if (next_client == 0) next_client = 1;
  clients.emplace(id, std::move(client));
  napi_value result = object(env, "pending"); number(env, result, "id", id); return result;
}
napi_value poll_request(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 1; napi_value arguments[1]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  unsigned id = 0;
  if (count != 1 || napi_get_value_uint32(env, arguments[0], &id) != napi_ok) return object(env, "refused");
  const auto found = clients.find(id);
  if (found == clients.end() || found->second->env != env) return object(env, "refused");
  Client& state = *found->second;
  const auto refused = [&]() { clients.erase(id); return object(env, "refused"); };
  if (GetTickCount64() - state.started > io_bound || alive(state.server) != 1) return refused();
  if (state.written < state.outgoing.size()) {
    DWORD wrote = 0;
    if (!WriteFile(state.pipe.value, state.outgoing.data() + state.written,
        static_cast<DWORD>(state.outgoing.size() - state.written), &wrote, nullptr)) return refused();
    state.written += wrote;
    return object(env, "pending");
  }
  DWORD available = 0;
  if (!PeekNamedPipe(state.pipe.value, nullptr, 0, nullptr, &available, nullptr)) return refused();
  if (available == 0) return object(env, "pending");
  const size_t offset = state.incoming.size();
  const DWORD wanted = std::min(available, frame_limit + 1 - static_cast<DWORD>(offset));
  state.incoming.resize(offset + wanted); DWORD got = 0;
  if (!ReadFile(state.pipe.value, state.incoming.data() + offset, wanted, &got, nullptr)) return refused();
  state.incoming.resize(offset + got);
  const auto end = std::find(state.incoming.begin(), state.incoming.end(), '\n');
  if (end != state.incoming.end()) {
    if (static_cast<size_t>(end - state.incoming.begin()) >= frame_limit) return refused();
    state.incoming.resize(static_cast<size_t>(end - state.incoming.begin()));
    napi_value result = object(env, "response"); buffer(env, result, "bytes", state.incoming); clients.erase(id); return result;
  }
  return state.incoming.size() >= frame_limit ? refused() : object(env, "pending");
}
napi_value close_request(napi_env env, napi_callback_info info) {
  Guard guard; size_t count = 1; napi_value arguments[1]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  unsigned id = 0;
  if (count == 1 && napi_get_value_uint32(env, arguments[0], &id) == napi_ok) {
    const auto found = clients.find(id); if (found != clients.end() && found->second->env == env) clients.erase(id);
  }
  return object(env, "closed");
}
} // namespace

NAPI_MODULE_INIT() {
  napi_add_env_cleanup_hook(env, cleanup_env, env);
  const napi_property_descriptor methods[] = {
    {"openProfile", nullptr, open_profile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"prepare", nullptr, prepare, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"claim", nullptr, claim, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"lookup", nullptr, lookup, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"poll", nullptr, poll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reply", nullptr, reply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, close_owner, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginRequest", nullptr, begin_request, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pollRequest", nullptr, poll_request, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeRequest", nullptr, close_request, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  number(env, exports, "frameBytes", frame_limit); number(env, exports, "apiVersion", 1);
  return exports;
}
