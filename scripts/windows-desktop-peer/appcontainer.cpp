#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <bcrypt.h>
#include <objbase.h>
#include <cstdio>
#include <cwchar>
#include <cstddef>
#include <cstdlib>
#include <array>
#include <string>
#include <vector>
#include "../../apps/desktop/src/native/desktopPeerWin32Wire.h"

namespace {
using Wire = octant::desktop_peer_win32::Wire;
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { reset(); }
  void reset() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
int refuse(const char* stage) { std::fprintf(stderr, "Owned AppContainer proof refused at %s (%lu).\n", stage, GetLastError()); return 2; }
bool missing(const std::wstring& path) {
  if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  const DWORD error = GetLastError(); return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}
bool ascii(const std::wstring& input, std::string& output) {
  output.clear(); output.reserve(input.size());
  for (wchar_t character : input) {
    if (character > 0x7f) return false;
    output.push_back(static_cast<char>(character));
  }
  return true;
}
bool token_data(HANDLE token, TOKEN_INFORMATION_CLASS kind, std::vector<unsigned char>& output) {
  DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size);
  if (size == 0 || size > 65536) return false;
  output.resize(size); return GetTokenInformation(token, kind, output.data(), size, &size) != FALSE;
}
std::string sha256(const std::string& value) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; unsigned char digest[32]{};
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
  const NTSTATUS status = BCryptHash(algorithm, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())), static_cast<ULONG>(value.size()), digest, sizeof(digest));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) return {};
  const char* hex = "0123456789abcdef"; std::string result;
  for (unsigned char byte : digest) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
bool transfer(HANDLE pipe, Wire& wire, bool writing) {
  Handle event; event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!event) return false;
  OVERLAPPED pending{}; pending.hEvent = event.value; DWORD done = 0;
  const BOOL immediate = writing ? WriteFile(pipe, &wire, sizeof(wire), &done, &pending) : ReadFile(pipe, &wire, sizeof(wire), &done, &pending);
  if (immediate) return done == sizeof(wire);
  if (GetLastError() != ERROR_IO_PENDING) return false;
  if (WaitForSingleObject(event.value, 2500) != WAIT_OBJECT_0) { CancelIoEx(pipe, &pending); GetOverlappedResult(pipe, &pending, &done, TRUE); SetLastError(ERROR_TIMEOUT); return false; }
  return GetOverlappedResult(pipe, &pending, &done, FALSE) && done == sizeof(wire);
}
bool status(const std::wstring& endpoint) {
  Handle pipe; pipe.value = CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | SECURITY_CONTEXT_TRACKING, nullptr);
  if (!pipe) return false;
  DWORD mode = PIPE_READMODE_MESSAGE;
  if (!SetNamedPipeHandleState(pipe.value, &mode, nullptr, nullptr)) return false;
  Wire request, reply; request.sequence = 1;
  if (!transfer(pipe.value, request, true) || !transfer(pipe.value, reply, false) || reply.magic != request.magic ||
      reply.protocol != 1 || reply.operation != 0 || reply.sequence != 1 || reply.status != 1) return false;
  const auto bytes = reinterpret_cast<const unsigned char*>(&reply);
  for (size_t i = offsetof(Wire, payload) + sizeof(reply.payload); i < sizeof(reply); ++i) if (bytes[i] != 0) return false;
  return true;
}
bool malformed(const std::wstring& endpoint) {
  for (unsigned mode : {1u, 2u}) {
    Handle pipe; pipe.value = CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | SECURITY_CONTEXT_TRACKING, nullptr);
    DWORD read_mode = PIPE_READMODE_MESSAGE;
    if (!pipe || !SetNamedPipeHandleState(pipe.value, &read_mode, nullptr, nullptr)) return false;
    Wire request, reply; request.sequence = 1;
    if (mode == 1) request.magic = 0;
    else {
      request.operation = 1; request.generation = 1;
      std::memset(request.window, 'X', 36);
      std::memcpy(request.payload + 1, "native-main-v1", sizeof("native-main-v1"));
    }
    if (!transfer(pipe.value, request, true)) return false;
    if (transfer(pipe.value, reply, false)) return false;
    const DWORD failure = GetLastError();
    if (failure != ERROR_BROKEN_PIPE && failure != ERROR_PIPE_NOT_CONNECTED && failure != ERROR_NO_DATA) return false;
  }
  return status(endpoint);
}
struct Fixture {
  std::wstring name, profile, scratch, executable;
  PSID app_sid = nullptr;
  PSECURITY_DESCRIPTOR security = nullptr;
  bool profile_created = false, scratch_created = false, executable_created = false, finished = false;
  Handle job, process, thread;
  bool finish() {
    if (finished) return true;
    finished = true;
    bool joined = true;
    if (job) {
      joined = TerminateJobObject(job.value, 2) != FALSE;
      const ULONGLONG deadline = GetTickCount64() + 3000;
      for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) { joined = false; break; }
        if (accounting.ActiveProcesses == 0) break;
        if (GetTickCount64() >= deadline) { joined = false; break; }
        Sleep(10);
      }
    }
    process.reset(); thread.reset(); job.reset();
    const bool files = (!executable_created || DeleteFileW(executable.c_str())) && (!scratch_created || RemoveDirectoryW(scratch.c_str()));
    const bool removed = !profile_created || SUCCEEDED(DeleteAppContainerProfile(name.c_str()));
    const bool storage_absent = !profile_created || (!profile.empty() && missing(profile));
    std::printf("{\"ownedAppContainerJobJoined\":%s,\"ownedAppContainerProfileRemoved\":%s,\"ownedAppContainerStorageAbsent\":%s,\"ownedAppContainerPathsAbsent\":%s}\n",
      joined ? "true" : "false", removed ? "true" : "false", storage_absent ? "true" : "false", files ? "true" : "false");
    return joined && files && removed && storage_absent;
  }
  ~Fixture() { if (!finished) finish(); if (app_sid) FreeSid(app_sid); if (security) LocalFree(security); }
};
bool inherit(DWORD name, Handle& output) {
  return DuplicateHandle(GetCurrentProcess(), GetStdHandle(name), GetCurrentProcess(), &output.value, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}
bool copy_program(const std::wstring& target, bool& created) {
  std::vector<wchar_t> name(32768); const DWORD count = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
  if (count == 0 || count >= name.size()) return false;
  Handle source, destination;
  source.value = CreateFileW(name.data(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  destination.value = CreateFileW(target.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_FLAG_WRITE_THROUGH, nullptr);
  created = static_cast<bool>(destination);
  if (!source || !destination) return false;
  std::array<unsigned char, 65536> bytes{};
  for (;;) {
    DWORD read = 0, wrote = 0;
    if (!ReadFile(source.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr)) return false;
    if (read == 0) break;
    if (!WriteFile(destination.value, bytes.data(), read, &wrote, nullptr) || wrote != read) return false;
  }
  return FlushFileBuffers(destination.value) != FALSE;
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 4 && std::wcscmp(argv[1], L"--appcontainer-child") == 0) {
    Handle token; token.value = nullptr;
    DWORD app = 0, size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) ||
        !GetTokenInformation(token.value, TokenIsAppContainer, &app, sizeof(app), &size) || app != 1) return refuse("actual-container-token");
    wchar_t* end = nullptr; const unsigned long parent = std::wcstoul(argv[3], &end, 10);
    if (!end || *end != 0 || parent == 0) return 2;
    Handle stolen; stolen.value = OpenProcess(PROCESS_DUP_HANDLE, FALSE, static_cast<DWORD>(parent));
    const bool cannot_steal = !stolen && GetLastError() == ERROR_ACCESS_DENIED;
    const bool refused = !status(argv[2]);
    std::printf("{\"actualAppContainer\":true,\"appContainerPeerRefused\":%s,\"appContainerCannotStealParentHandles\":%s}\n", refused ? "true" : "false", cannot_steal ? "true" : "false");
    return refused && cannot_steal ? 0 : 2;
  }
  if (argc != 3) return 2;
  const std::wstring scope(argv[1]);
  if (scope.size() != 36 || scope.find_first_not_of(L"0123456789abcdef-") != std::wstring::npos) return 2;
  Handle token; token.value = nullptr;
  std::vector<unsigned char> user;
  DWORD session = 0, size = 0; TOKEN_STATISTICS statistics{};
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) || !token_data(token.value, TokenUser, user) ||
      !GetTokenInformation(token.value, TokenSessionId, &session, sizeof(session), &size) ||
      !GetTokenInformation(token.value, TokenStatistics, &statistics, sizeof(statistics), &size)) return refuse("owner-facts");
  const PSID user_sid = reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid;
  std::string profile; if (!ascii(scope, profile)) return refuse("scope-ascii");
  const std::string identity = sha256(profile + ":" + std::to_string(session) + ":" + std::to_string(statistics.AuthenticationId.HighPart) + ":" +
    std::to_string(statistics.AuthenticationId.LowPart) + ":" + std::string(static_cast<const char*>(user_sid), GetLengthSid(user_sid)));
  if (identity.size() != 64) return refuse("endpoint-digest");
  const std::wstring endpoint = L"\\\\.\\pipe\\Octant-desktop-" + std::wstring(identity.begin(), identity.end());
  if (!status(endpoint)) return refuse("unconfined-endpoint-control");
  if (!malformed(endpoint)) return refuse("malformed-native-frames");
  std::puts("{\"unconfinedNativeEndpointControl\":true,\"malformedNativeFramesRefused\":true,\"nativeFramePaddingZero\":true}");
  Fixture fixture;
  std::array<unsigned char, 16> nonce{};
  if (BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return refuse("owned-profile-nonce");
  const wchar_t* hex = L"0123456789abcdef"; fixture.name = L"octant-peer-qa.";
  for (unsigned char byte : nonce) { fixture.name += hex[byte >> 4]; fixture.name += hex[byte & 15]; }
  HRESULT created = CreateAppContainerProfile(fixture.name.c_str(), L"Octant peer QA", L"Disposable native peer refusal", nullptr, 0, &fixture.app_sid);
  if (FAILED(created)) { SetLastError(HRESULT_CODE(created)); return refuse("unique-owned-profile"); }
  fixture.profile_created = true;
  std::string owned_name; if (!ascii(fixture.name, owned_name)) return refuse("owned-name-ascii");
  std::printf("{\"ownedAppContainerProfileCreated\":true,\"ownedAppContainerProfileName\":\"%s\"}\n", owned_name.c_str());
  LPWSTR user_text = nullptr, app_text = nullptr, folder = nullptr;
  if (!ConvertSidToStringSidW(user_sid, &user_text) || !ConvertSidToStringSidW(fixture.app_sid, &app_text)) {
    if (user_text) LocalFree(user_text); if (app_text) LocalFree(app_text); return refuse("owned-public-acl");
  }
  const HRESULT located = GetAppContainerFolderPath(app_text, &folder);
  const std::wstring sddl = L"O:" + std::wstring(user_text) + L"D:P(A;OICI;FA;;;" + user_text + L")(A;OICI;FA;;;SY)(A;OICI;GRGX;;;" + app_text + L")";
  LocalFree(user_text); LocalFree(app_text);
  if (FAILED(located) || !folder) return refuse("owned-profile-storage");
  fixture.profile = folder; CoTaskMemFree(folder);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &fixture.security, nullptr)) return refuse("owned-public-security");
  std::vector<wchar_t> temporary(32768); const DWORD length = GetTempPathW(static_cast<DWORD>(temporary.size()), temporary.data());
  if (length == 0 || length >= temporary.size()) return refuse("owned-temporary-root");
  fixture.scratch = std::wstring(temporary.data(), length) + fixture.name;
  SECURITY_ATTRIBUTES acl{sizeof(SECURITY_ATTRIBUTES), fixture.security, FALSE};
  if (!CreateDirectoryW(fixture.scratch.c_str(), &acl)) return refuse("new-owned-public-directory");
  fixture.scratch_created = true;
  fixture.executable = fixture.scratch + L"\\peer-appcontainer.exe";
  if (!copy_program(fixture.executable, fixture.executable_created)) return refuse("owned-public-program-copy");
  SIZE_T attribute_size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
  if (attribute_size == 0 || attribute_size > 65536) return refuse("attribute-bound");
  std::vector<unsigned char> attributes(attribute_size);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &attribute_size)) return refuse("owned-attributes");
  struct AttributeCleanup { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributeCleanup() { DeleteProcThreadAttributeList(value); } } attribute_cleanup{list};
  SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = fixture.app_sid;
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), nullptr, nullptr)) return refuse("actual-appcontainer-attribute");
  fixture.job.value = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!fixture.job || !SetInformationJobObject(fixture.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return refuse("owned-container-job");
  Handle input, output, error;
  if (!inherit(STD_INPUT_HANDLE, input) || !inherit(STD_OUTPUT_HANDLE, output) || !inherit(STD_ERROR_HANDLE, error)) return refuse("owned-container-stdio");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.value; startup.StartupInfo.hStdOutput = output.value; startup.StartupInfo.hStdError = error.value; startup.lpAttributeList = list;
  const std::wstring parent(argv[2]);
  if (parent.empty() || parent.find_first_not_of(L"0123456789") != std::wstring::npos) return 2;
  std::wstring command = L"\"" + fixture.executable + L"\" --appcontainer-child \"" + endpoint + L"\" " + parent;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(fixture.executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup.StartupInfo, &process)) return refuse("actual-container-child");
  fixture.process.value = process.hProcess; fixture.thread.value = process.hThread;
  if (!AssignProcessToJobObject(fixture.job.value, fixture.process.value)) { TerminateProcess(fixture.process.value, 2); WaitForSingleObject(fixture.process.value, 3000); return refuse("owned-container-assignment"); }
  if (ResumeThread(fixture.thread.value) == static_cast<DWORD>(-1)) return refuse("owned-container-resume");
  const DWORD waited = WaitForSingleObject(fixture.process.value, 10000); DWORD result = 2;
  if (waited == WAIT_OBJECT_0) GetExitCodeProcess(fixture.process.value, &result);
  const bool cleanup = fixture.finish();
  return waited == WAIT_OBJECT_0 && result == 0 && cleanup ? 0 : 2;
}
