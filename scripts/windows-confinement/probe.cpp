#include <winsock2.h>
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <objbase.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

// Native feasibility only. No host launcher imports or packages this fixture.
namespace fs = std::filesystem;

struct Failure { DWORD code; };
static bool processes_exited = true;
static void require(BOOL result) { if (!result) throw Failure{GetLastError()}; }
static void hresult(HRESULT result) { if (FAILED(result)) throw Failure{static_cast<DWORD>(result)}; }

class Handle {
  HANDLE value_ = nullptr;
public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) { if (value == INVALID_HANDLE_VALUE || !value) throw Failure{GetLastError()}; }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { close(); }
  HANDLE get() const { return value_; }
  void adopt(HANDLE value) { if (value_) throw Failure{ERROR_INVALID_HANDLE}; value_ = value; }
  void close() { if (value_) { CloseHandle(value_); value_ = nullptr; } }
};

static std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') { ++slashes; continue; }
    result.append(ch == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
    result += ch; slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'\"';
}

static std::wstring executable() {
  std::vector<wchar_t> path(32768);
  DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!length || length == path.size()) throw Failure{ERROR_BAD_PATHNAME};
  return std::wstring(path.data(), length);
}

static DWORD read_file(const fs::path& path) {
  HANDLE raw = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (raw == INVALID_HANDLE_VALUE) return GetLastError();
  Handle file(raw);
  char content[32] = {};
  DWORD count = 0;
  if (!ReadFile(file.get(), content, sizeof(content), &count, nullptr)) return GetLastError();
  return std::string(content, count) == "fixture-sentinel" ? ERROR_SUCCESS : ERROR_INVALID_DATA;
}

static void write_file(const fs::path& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  constexpr char content[] = "fixture-sentinel";
  DWORD written = 0;
  require(WriteFile(file.get(), content, sizeof(content) - 1, &written, nullptr));
  if (written != sizeof(content) - 1) throw Failure{ERROR_WRITE_FAULT};
}

static void grant(const fs::path& path, PSID sid, DWORD access, DWORD inheritance) {
  PACL previous = nullptr, updated = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &previous, nullptr, &descriptor);
  if (result) throw Failure{result};
  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = access;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = inheritance;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  result = SetEntriesInAclW(1, &entry, previous, &updated);
  if (!result) result = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr);
  if (updated) LocalFree(updated);
  LocalFree(descriptor);
  if (result) throw Failure{result};
}

static void private_directory(const fs::path& path) {
  Handle token([] { HANDLE value = nullptr; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &value)); return value; }());
  DWORD length = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &length);
  std::vector<BYTE> info(length);
  require(GetTokenInformation(token.get(), TokenUser, info.data(), length, &length));
  LPWSTR sid = nullptr;
  require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid, &sid));
  std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr));
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor, FALSE};
  BOOL created = CreateDirectoryW(path.c_str(), &attributes);
  DWORD error = GetLastError();
  LocalFree(descriptor);
  if (!created) throw Failure{error};
}

static bool appcontainer_token(HANDLE process) {
  HANDLE raw = nullptr;
  require(OpenProcessToken(process, TOKEN_QUERY, &raw));
  Handle token(raw);
  DWORD app = 0, lpac = 0, length = 0;
  require(GetTokenInformation(token.get(), TokenIsAppContainer, &app, sizeof(app), &length));
  require(GetTokenInformation(token.get(), TokenIsLessPrivilegedAppContainer, &lpac, sizeof(lpac), &length));
  return app != 0 && lpac != 0;
}

class Child {
  Handle job_;
  Handle ready_;
  Handle gate_;
  Handle process_;
public:
  Child(const fs::path& binary, PSID sid, const std::wstring& arguments)
    : job_(CreateJobObjectW(nullptr, nullptr)), ready_(event()), gate_(event()) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 3, 0, &size);
    std::vector<BYTE> storage(size);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(list, 3, 0, &size));
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } cleanup{list};
    SECURITY_CAPABILITIES capabilities{};
    capabilities.AppContainerSid = sid;
    DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    HANDLE inherited[] = {ready_.get(), gate_.get()};
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
      &capabilities, sizeof(capabilities), nullptr, nullptr));
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
      &policy, sizeof(policy), nullptr, nullptr));
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited, sizeof(inherited), nullptr, nullptr));
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = list;
    std::wstring command = quote(binary.wstring()) + L" --child " +
      std::to_wstring(reinterpret_cast<uintptr_t>(ready_.get())) + L" " +
      std::to_wstring(reinterpret_cast<uintptr_t>(gate_.get())) + L" " + arguments;
    PROCESS_INFORMATION created{};
    require(CreateProcessW(binary.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
      nullptr, binary.parent_path().c_str(), &startup.StartupInfo, &created));
    Handle thread(created.hThread);
    process_.adopt(created.hProcess);
    try {
      // Verify the actual token and assign the Job before the first instruction.
      require(AssignProcessToJobObject(job_.get(), process_.get()));
      if (!appcontainer_token(process_.get())) throw Failure{ERROR_BAD_TOKEN_TYPE};
      if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) throw Failure{GetLastError()};
      if (WaitForSingleObject(ready_.get(), 5000) != WAIT_OBJECT_0) throw Failure{WAIT_TIMEOUT};
    } catch (...) {
      TerminateProcess(process_.get(), ERROR_PROCESS_ABORTED);
      job_.close();
      processes_exited = WaitForSingleObject(process_.get(), 5000) == WAIT_OBJECT_0 && processes_exited;
      throw;
    }
  }
  static HANDLE event() {
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
    return CreateEventW(&attributes, TRUE, FALSE, nullptr);
  }
  // Child retains no copy of the Job handle. Closing it also works on owner exit.
  ~Child() { job_.close(); if (process_.get()) processes_exited = WaitForSingleObject(process_.get(), 5000) == WAIT_OBJECT_0 && processes_exited; }
  DWORD run() {
    require(SetEvent(gate_.get()));
    if (WaitForSingleObject(process_.get(), 5000) != WAIT_OBJECT_0) throw Failure{WAIT_TIMEOUT};
    DWORD code = 0; require(GetExitCodeProcess(process_.get(), &code)); return code;
  }
  bool kill_subtree() {
    require(SetEvent(gate_.get()));
    // Query the owned Job, then retain each actual process before closing it.
    struct ProcessList { DWORD assigned; DWORD count; ULONG_PTR ids[16]; } list{};
    bool found = false;
    std::vector<HANDLE> descendants;
    for (int attempt = 0; attempt < 100; ++attempt) {
      require(QueryInformationJobObject(job_.get(), JobObjectBasicProcessIdList, &list, sizeof(list), nullptr));
      if (list.count >= 2) { found = true; break; }
      Sleep(20);
    }
    if (found) for (DWORD i = 0; i < list.count; ++i) {
      HANDLE value = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(list.ids[i]));
      if (!value) { for (HANDLE previous : descendants) CloseHandle(previous); throw Failure{GetLastError()}; }
      descendants.push_back(value);
    }
    job_.close();
    bool exited = found;
    for (HANDLE value : descendants) { exited = WaitForSingleObject(value, 5000) == WAIT_OBJECT_0 && exited; CloseHandle(value); }
    processes_exited = exited && processes_exited;
    return exited;
  }
};

static DWORD network_probe(unsigned short port) {
  WSADATA data{};
  int started = WSAStartup(MAKEWORD(2, 2), &data);
  if (started) return static_cast<DWORD>(started);
  SOCKET socket_value = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  DWORD result = 0;
  if (socket_value == INVALID_SOCKET) result = static_cast<DWORD>(WSAGetLastError());
  else {
    u_long nonblocking = 1;
    if (ioctlsocket(socket_value, FIONBIO, &nonblocking)) result = static_cast<DWORD>(WSAGetLastError());
    else {
      sockaddr_in target{}; target.sin_family = AF_INET; target.sin_addr.s_addr = htonl(INADDR_LOOPBACK); target.sin_port = htons(port);
      if (connect(socket_value, reinterpret_cast<sockaddr*>(&target), sizeof(target))) {
        result = static_cast<DWORD>(WSAGetLastError());
        if (result == WSAEWOULDBLOCK) {
          fd_set write_set, errors; FD_ZERO(&write_set); FD_ZERO(&errors); FD_SET(socket_value, &write_set); FD_SET(socket_value, &errors);
          timeval timeout{2, 0};
          int selected = select(0, nullptr, &write_set, &errors, &timeout);
          int error = 0, length = sizeof(error);
          result = selected > 0 && !getsockopt(socket_value, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &length)
            ? static_cast<DWORD>(error) : WAIT_TIMEOUT;
        }
      }
    }
    closesocket(socket_value);
  }
  WSACleanup(); return result;
}

static int child(int argc, wchar_t** argv) {
  if (argc < 6) return ERROR_INVALID_PARAMETER;
  HANDLE ready = reinterpret_cast<HANDLE>(std::stoull(argv[2]));
  HANDLE gate = reinterpret_cast<HANDLE>(std::stoull(argv[3]));
  require(SetEvent(ready));
  if (WaitForSingleObject(gate, 10000) != WAIT_OBJECT_0) return WAIT_TIMEOUT;
  std::wstring action = argv[4];
  if (action == L"read") return static_cast<int>(read_file(argv[5]));
  if (action == L"write") {
    HANDLE file = CreateFileW(argv[5], GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return static_cast<int>(GetLastError());
    CloseHandle(file); return ERROR_SUCCESS;
  }
  if (action == L"network") return static_cast<int>(network_probe(static_cast<unsigned short>(std::stoul(argv[5]))));
  if (action == L"subtree") {
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION created{};
    std::wstring command = quote(executable()) + L" --wait";
    require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
      nullptr, nullptr, &startup, &created));
    CloseHandle(created.hThread); CloseHandle(created.hProcess);
    Sleep(30000); return ERROR_TIMEOUT;
  }
  return ERROR_INVALID_PARAMETER;
}

struct Measurement { const char* name; DWORD observed; DWORD expected; };

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc > 1 && std::wstring(argv[1]) == L"--child") return child(argc, argv);
    if (argc > 1 && std::wstring(argv[1]) == L"--wait") { Sleep(30000); return ERROR_TIMEOUT; }
    if (argc != 2) { std::cerr << "usage: probe evidence.json\n"; return 2; }
    GUID id{}; hresult(CoCreateGuid(&id));
    wchar_t text[40]{}; StringFromGUID2(id, text, 40);
    std::wstring suffix(text + 1, 36);
    std::wstring name = L"Octant.Feasibility." + suffix;
    fs::path root = fs::temp_directory_path() / (L"octant-confinement-" + suffix);
    PSID sid = nullptr;
    bool profile_created = false, root_created = false;
    std::vector<Measurement> measurements;
    DWORD failure = 0;
    try {
      hresult(CreateAppContainerProfile(name.c_str(), L"Octant feasibility", L"Disposable native measurements", nullptr, 0, &sid));
      profile_created = true;
      private_directory(root); root_created = true;
      grant(root, sid, FILE_TRAVERSE | SYNCHRONIZE, NO_INHERITANCE);
      fs::create_directory(root / L"bin"); fs::create_directory(root / L"allowed");
      grant(root / L"bin", sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SUB_CONTAINERS_AND_OBJECTS_INHERIT);
      grant(root / L"allowed", sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SUB_CONTAINERS_AND_OBJECTS_INHERIT);
      fs::path binary = root / L"bin" / L"probe.exe";
      fs::copy_file(executable(), binary);
      write_file(root / L"allowed" / L"existing"); write_file(root / L"outside-secret");
      auto measure = [&](const char* label, const std::wstring& action, const fs::path& path, DWORD expected, bool late) {
        Child process(binary, sid, action + L" " + quote(path.wstring()));
        if (late) write_file(path);
        measurements.push_back({label, process.run(), expected});
      };
      measure("reads permitted existing file", L"read", root / L"allowed" / L"existing", 0, false);
      measure("denies an ungranted sibling secret", L"read", root / L"outside-secret", ERROR_ACCESS_DENIED, false);
      measure("sees permitted file created after child starts", L"read", root / L"allowed" / L"late-allowed", 0, true);
      measure("denies protected filename created after child starts", L"read", root / L"allowed" / L"id_late", ERROR_ACCESS_DENIED, true);
      measure("read-only grant refuses opening for write", L"write", root / L"allowed" / L"existing", ERROR_ACCESS_DENIED, false);
      measurements.push_back({"unconfined host still reads the protected fixture", read_file(root / L"allowed" / L"id_late"), 0});
      {
        WSADATA data{};
        int started = WSAStartup(MAKEWORD(2, 2), &data);
        if (started) throw Failure{static_cast<DWORD>(started)};
        struct Winsock { ~Winsock() { WSACleanup(); } } winsock;
        SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listener == INVALID_SOCKET) throw Failure{static_cast<DWORD>(WSAGetLastError())};
        struct Socket { SOCKET value; ~Socket() { closesocket(value); } } owned{listener};
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(listener, 1))
          throw Failure{static_cast<DWORD>(WSAGetLastError())};
        int length = sizeof(address);
        if (getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length))
          throw Failure{static_cast<DWORD>(WSAGetLastError())};
        Child process(binary, sid, L"network " + std::to_wstring(ntohs(address.sin_port)));
        measurements.push_back({"no-capability child refuses owned loopback connection", process.run(), WSAEACCES});
      }
      {
        Child process(binary, sid, L"subtree ignored");
        measurements.push_back({"closing the owned Job exits child and descendant", process.kill_subtree() ? 0u : ERROR_PROCESS_ABORTED, 0});
      }
    } catch (const Failure& error) { failure = error.code; }
      catch (const std::exception&) { failure = ERROR_GEN_FAILURE; }
    if (sid) FreeSid(sid);
    bool profile_removed = !profile_created || SUCCEEDED(DeleteAppContainerProfile(name.c_str()));
    std::error_code removal;
    if (root_created) fs::remove_all(root, removal);
    bool fixture_removed = !removal && !fs::exists(root);
    bool cleanup = profile_removed && processes_exited && fixture_removed;
    std::ofstream output{fs::path(argv[1])};
    output << "{\"productionReady\":false,\"status\":\"" << (failure ? "failed" : "measured")
      << "\",\"error\":" << failure << ",\"profileRemoved\":" << (profile_removed ? "true" : "false")
      << ",\"processesExited\":" << (processes_exited ? "true" : "false")
      << ",\"fixtureRemoved\":" << (fixture_removed ? "true" : "false") << ",\"measurements\":[";
    for (size_t index = 0; index < measurements.size(); ++index) {
      const auto& value = measurements[index];
      if (index) output << ',';
      output << "{\"name\":\"" << value.name << "\",\"observed\":" << value.observed << ",\"expected\":"
        << value.expected << ",\"passed\":" << (value.observed == value.expected ? "true" : "false") << '}';
    }
    output << "]}\n"; output.close();
    return failure || !cleanup || !output ? 1 : 0;
  } catch (const Failure& error) { std::cerr << "native failure " << error.code << '\n'; return 1; }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
