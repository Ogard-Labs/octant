#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <delayimp.h>
#include <node_api.h>
#include "desktopPeerWin32Wire.h"
#include <algorithm>
#include <atomic>
#include <array>
#include <cmath>
#include <chrono>
#include <cstdint>
#include <exception>
#include <condition_variable>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

static FARPROC WINAPI desktop_runtime(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
  return nullptr;
}
extern "C" const PfnDliHook __pfnDliNotifyHook2 = desktop_runtime;

namespace {
constexpr DWORD operation_bound = 2500;
constexpr ULONGLONG safe_integer = 9007199254740991ULL;
constexpr size_t max_peers = 32, max_connections = 64;
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
using Wire = octant::desktop_peer_win32::Wire;
struct Principal {
  std::vector<unsigned char> sid, logon_sid;
  DWORD session = 0;
  LUID logon{};
};
struct Peer {
  Handle process;
  DWORD pid = 0;
  FILETIME born{};
  std::string key;
};
struct Pending {
  std::mutex lock;
  std::condition_variable changed;
  bool answered = false;
  std::string payload;
  ~Pending() { if (!payload.empty()) SecureZeroMemory(payload.data(), payload.size()); }
};
struct Notice {
  bool exited = false;
  std::string peer, window, operation;
  ULONGLONG id = 0, generation = 0;
};
struct Connection {
  Handle pipe;
  std::thread worker;
  std::atomic<bool> finished = false;
};
struct Runtime {
  napi_env env = nullptr;
  DWORD thread = 0;
  Principal principal;
  std::wstring endpoint;
  std::string profile, version;
  PSECURITY_DESCRIPTOR security = nullptr;
  Handle stopping{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::mutex lifecycle, lock, client_lock;
  std::atomic<bool> closed = false, retired = false;
  std::atomic<bool> status_enabled = false, windows_enabled = false;
  std::thread acceptor;
  napi_threadsafe_function callback = nullptr;
  std::map<ULONGLONG, std::shared_ptr<Pending>> pending;
  std::map<std::string, size_t> peers;
  ULONGLONG next_request = 1;
  std::unique_ptr<Peer> client_peer;
  Handle client_pipe, admission;
  std::atomic<ULONGLONG> next_sequence = 1;
  std::atomic<bool> start_pending = false, status_pending = false, window_pending = false,
    close_pending = false, listen_pending = false, stop_pending = false;
  ~Runtime() { if (security) LocalFree(security); }
};
std::mutex binding_lock;
std::shared_ptr<Runtime> runtime;
char module_anchor;

bool live(const Peer& peer) { return peer.process && WaitForSingleObject(peer.process.value, 0) == WAIT_TIMEOUT; }
bool stopped(const Runtime& state) { return state.closed || WaitForSingleObject(state.stopping.value, 0) != WAIT_TIMEOUT; }
bool token_principal(HANDLE token, Principal& result) {
  DWORD app_container = 1, size = 0;
  TOKEN_STATISTICS statistics{};
  if (IsTokenRestricted(token) || !GetTokenInformation(token, TokenIsAppContainer, &app_container, sizeof(app_container), &size) || app_container ||
      !GetTokenInformation(token, TokenSessionId, &result.session, sizeof(result.session), &size) ||
      !GetTokenInformation(token, TokenStatistics, &statistics, sizeof(statistics), &size)) return false;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (size == 0 || size > 65536) return false;
  std::vector<unsigned char> bytes(size);
  if (!GetTokenInformation(token, TokenUser, bytes.data(), size, &size)) return false;
  const auto user = reinterpret_cast<const TOKEN_USER*>(bytes.data());
  if (!IsValidSid(user->User.Sid)) return false;
  const DWORD length = GetLengthSid(user->User.Sid);
  result.sid.resize(length);
  if (!CopySid(length, result.sid.data(), user->User.Sid)) return false;
  result.logon = statistics.AuthenticationId;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
  if (size == 0 || size > 65536) return false;
  bytes.resize(size);
  if (!GetTokenInformation(token, TokenIntegrityLevel, bytes.data(), size, &size)) return false;
  const PSID integrity = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(bytes.data())->Label.Sid;
  if (!IsValidSid(integrity) || *GetSidSubAuthorityCount(integrity) == 0 ||
      *GetSidSubAuthority(integrity, static_cast<DWORD>(*GetSidSubAuthorityCount(integrity) - 1)) < SECURITY_MANDATORY_MEDIUM_RID) return false;
  GetTokenInformation(token, TokenGroups, nullptr, 0, &size);
  if (size == 0 || size > 65536) return false;
  bytes.resize(size);
  if (!GetTokenInformation(token, TokenGroups, bytes.data(), size, &size)) return false;
  const auto groups = reinterpret_cast<const TOKEN_GROUPS*>(bytes.data());
  for (DWORD i = 0; i < groups->GroupCount; ++i) {
    const auto& group = groups->Groups[i];
    if ((group.Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
    if (!result.logon_sid.empty() || !IsValidSid(group.Sid)) return false;
    const DWORD logon_length = GetLengthSid(group.Sid); result.logon_sid.resize(logon_length);
    if (!CopySid(logon_length, result.logon_sid.data(), group.Sid)) return false;
  }
  return !result.logon_sid.empty();
}
PSID sid_of(const Principal& value) { return const_cast<unsigned char*>(value.sid.data()); }
bool same_principal(const Principal& a, const Principal& b) {
  return !a.sid.empty() && !b.sid.empty() && EqualSid(sid_of(a), sid_of(b)) && a.session == b.session &&
    a.logon.LowPart == b.logon.LowPart && a.logon.HighPart == b.logon.HighPart &&
    !a.logon_sid.empty() && !b.logon_sid.empty() && EqualSid(const_cast<unsigned char*>(a.logon_sid.data()), const_cast<unsigned char*>(b.logon_sid.data()));
}
std::string hash(const std::string& input) {
  unsigned char digest[32]{};
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
  const NTSTATUS status = BCryptHash(algorithm, nullptr, 0,
    reinterpret_cast<PUCHAR>(const_cast<char*>(input.data())), static_cast<ULONG>(input.size()), digest, sizeof(digest));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) return {};
  static constexpr char hex[] = "0123456789abcdef";
  std::string value;
  for (unsigned char byte : digest) { value += hex[byte >> 4]; value += hex[byte & 15]; }
  return value;
}
bool process_peer(DWORD pid, const Runtime& state, Peer& result) {
  result.process = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  Handle token;
  HANDLE raw = nullptr;
  FILETIME exited{}, kernel{}, user{};
  Principal principal;
  if (!result.process || !OpenProcessToken(result.process.value, TOKEN_QUERY, &raw)) return false;
  token = Handle(raw);
  if (!token_principal(token.value, principal) || !same_principal(state.principal, principal) ||
      !GetProcessTimes(result.process.value, &result.born, &exited, &kernel, &user)) return false;
  result.pid = pid;
  result.key = hash(state.profile + ":" + std::to_string(state.principal.session) + ":" +
    std::to_string(state.principal.logon.HighPart) + ":" + std::to_string(state.principal.logon.LowPart) + ":" + std::to_string(pid) + ":" +
    std::to_string(result.born.dwHighDateTime) + ":" + std::to_string(result.born.dwLowDateTime));
  return result.key.size() == 64 && live(result);
}
// The token is the kernel security context of the last message read, never
// fields in that message. Identification-only SQOS cannot impersonate outward.
bool from_client(HANDLE pipe, const Runtime& state, const Peer& peer) {
  ULONG pid = 0;
  if (!live(peer) || !GetNamedPipeClientProcessId(pipe, &pid) || pid != peer.pid || !ImpersonateNamedPipeClient(pipe)) return false;
  HANDLE raw = nullptr;
  const bool opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &raw) != FALSE;
  Handle token(raw);
  Principal principal;
  const bool accepted = opened && token_principal(token.value, principal) && same_principal(state.principal, principal);
  if (!RevertToSelf()) std::terminate();
  return accepted && live(peer);
}
bool private_pipe(HANDLE pipe, const Runtime& state) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(pipe, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  bool accepted = owner && IsValidSid(owner) && EqualSid(owner, sid_of(state.principal)) && acl && IsValidAcl(acl) && acl->AceCount == 2 &&
    GetSecurityDescriptorControl(descriptor, &control, &revision) && (control & SE_DACL_PROTECTED) != 0;
  BYTE system[SECURITY_MAX_SID_SIZE]{}; DWORD length = sizeof(system);
  accepted = accepted && CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &length);
  bool user_ace = false, system_ace = false;
  for (DWORD i = 0; accepted && i < acl->AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(acl, i, &raw)) { accepted = false; break; }
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    const PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceSize < sizeof(ACCESS_ALLOWED_ACE) || ace->Header.AceFlags != 0 ||
        ace->Mask != FILE_ALL_ACCESS || !IsValidSid(sid)) { accepted = false; break; }
    if (EqualSid(sid, sid_of(state.principal)) && !user_ace) user_ace = true;
    else if (EqualSid(sid, system) && !system_ace) system_ace = true;
    else accepted = false;
  }
  if (descriptor) LocalFree(descriptor);
  return accepted && user_ace && system_ace;
}

bool valid_text(const std::string& text, size_t maximum, const char* alphabet) {
  return !text.empty() && text.size() <= maximum && text.find_first_not_of(alphabet) == std::string::npos;
}
bool uuid(const std::string& value) {
  if (value.size() != 36) return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
    else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}
bool main_thread() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0));
  THREADENTRY32 entry{}; entry.dwSize = sizeof(entry);
  if (!snapshot || !Thread32First(snapshot.value, &entry)) return false;
  FILETIME earliest{MAXDWORD, MAXDWORD}; DWORD primary = 0;
  do {
    if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
    Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ThreadID));
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!thread) { if (GetLastError() == ERROR_INVALID_PARAMETER) continue; return false; }
    if (GetProcessIdOfThread(thread.value) != GetCurrentProcessId()) continue;
    if (!GetThreadTimes(thread.value, &created, &exited, &kernel, &user)) return false;
    if (CompareFileTime(&created, &earliest) < 0) { earliest = created; primary = entry.th32ThreadID; }
  } while (Thread32Next(snapshot.value, &entry));
  return primary == GetCurrentThreadId();
}
bool transfer(HANDLE pipe, void* bytes, DWORD length, bool writing, HANDLE stop, HANDLE process, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event) return false;
  OVERLAPPED operation{}; operation.hEvent = event.value;
  DWORD done = 0;
  // A queued native job can already be expired when its first I/O starts.
  // Immediate completions need the same admission as overlapped waits.
  const ULONGLONG now = GetTickCount64();
  if ((deadline != 0 && now >= deadline) || WaitForSingleObject(stop, 0) != WAIT_TIMEOUT ||
      (process && WaitForSingleObject(process, 0) != WAIT_TIMEOUT)) {
    SetLastError(deadline != 0 && now >= deadline ? ERROR_TIMEOUT : ERROR_BROKEN_PIPE);
    return false;
  }
  const BOOL immediate = writing ? WriteFile(pipe, bytes, length, &done, &operation) : ReadFile(pipe, bytes, length, &done, &operation);
  if (immediate) { if (done != length) SetLastError(ERROR_INVALID_DATA); return done == length; }
  if (GetLastError() != ERROR_IO_PENDING) return false;
  HANDLE waits[]{event.value, stop, process};
  DWORD timeout = INFINITE;
  if (deadline != 0) {
    const ULONGLONG waited_at = GetTickCount64();
    timeout = static_cast<DWORD>(std::min<ULONGLONG>(operation_bound, deadline > waited_at ? deadline - waited_at : 0));
  }
  const DWORD ready = WaitForMultipleObjects(process ? 3 : 2, waits, FALSE, timeout);
  if (ready != WAIT_OBJECT_0) {
    CancelIoEx(pipe, &operation);
    // The stack OVERLAPPED and buffer cannot leave scope before cancellation joins.
    GetOverlappedResult(pipe, &operation, &done, TRUE);
    SetLastError(ready == WAIT_TIMEOUT ? ERROR_TIMEOUT : ERROR_BROKEN_PIPE);
    return false;
  }
  return GetOverlappedResult(pipe, &operation, &done, FALSE) && done == length;
}
bool valid_request(const Wire& wire) {
  if (wire.magic != 0x4f435450 || wire.protocol != 1 || wire.status != 0 || wire.operation > 3 || wire.sequence == 0 || wire.sequence > safe_integer ||
      !std::memchr(wire.version, 0, sizeof(wire.version))) return false;
  if (wire.operation == 0) return wire.generation == 0 && wire.window[0] == 0 && wire.payload[0] == 0 && wire.payload[1] == 0;
  return wire.generation > 0 && wire.generation <= safe_integer && wire.window[36] == 0 &&
    uuid(wire.window) && wire.payload[0] == 0 &&
    std::memcmp(wire.payload + 1, "native-main-v1", sizeof("native-main-v1")) == 0;
}
void put(napi_env env, napi_value value, const char* key, const std::string& text) {
  napi_value encoded; napi_create_string_utf8(env, text.c_str(), text.size(), &encoded); napi_set_named_property(env, value, key, encoded);
}
void number(napi_env env, napi_value value, const char* key, ULONGLONG input) {
  napi_value encoded; napi_create_double(env, static_cast<double>(input), &encoded); napi_set_named_property(env, value, key, encoded);
}
napi_value result(napi_env env, const std::string& kind, const std::string& reason = {}) {
  napi_value out; napi_create_object(env, &out); put(env, out, "kind", kind);
  if (!reason.empty()) put(env, out, "reason", reason);
  return out;
}
void callback(napi_env env, napi_value function, void*, void* data) {
  std::unique_ptr<Notice> notice(static_cast<Notice*>(data));
  if (!env || !function) return;
  napi_value event = result(env, notice->exited ? "peer-exited" : "request");
  if (notice->exited) put(env, event, "peer", notice->peer);
  else {
    napi_value request; napi_create_object(env, &request);
    put(env, request, "peer", notice->peer); put(env, request, "windowId", notice->window); put(env, request, "operation", notice->operation);
    number(env, request, "requestId", notice->id); number(env, request, "generation", notice->generation);
    napi_value native_main; napi_get_boolean(env, true, &native_main); napi_set_named_property(env, request, "nativeMain", native_main);
    napi_set_named_property(env, event, "request", request);
  }
  napi_value global, ignored; napi_get_global(env, &global); napi_call_function(env, global, function, 1, &event, &ignored);
}
bool notify(Runtime& state, std::unique_ptr<Notice> notice) {
  std::lock_guard guard(state.lock);
  if (!state.callback || !state.windows_enabled || stopped(state) ||
      napi_call_threadsafe_function(state.callback, notice.get(), napi_tsfn_nonblocking) != napi_ok) return false;
  notice.release(); return true;
}
std::string window_reply(Runtime& state, const Peer& peer, const Wire& request) {
  const auto unavailable = [] { return std::string("{\"kind\":\"refused\",\"reason\":\"unavailable\"}"); };
  auto pending = std::make_shared<Pending>(); ULONGLONG id = 0;
  {
    std::lock_guard guard(state.lock);
    if (!state.windows_enabled || !state.callback || state.next_request > safe_integer || state.pending.size() >= max_peers) return unavailable();
    id = state.next_request++; state.pending.emplace(id, pending);
  }
  auto notice = std::make_unique<Notice>(); notice->peer = peer.key; notice->window = request.window;
  notice->operation = request.operation == 1 ? "register" : request.operation == 2 ? "renew" : "revoke";
  notice->id = id; notice->generation = request.generation;
  const bool sent = notify(state, std::move(notice));
  std::string answer; bool expired = false;
  if (sent) {
    std::unique_lock guard(pending->lock);
    expired = !pending->changed.wait_for(guard, std::chrono::milliseconds(operation_bound), [&] { return pending->answered || stopped(state) || !state.windows_enabled; });
    if (pending->answered && !stopped(state)) answer = pending->payload;
  }
  { std::lock_guard guard(state.lock); state.pending.erase(id); }
  if (expired) return "{\"kind\":\"refused\",\"reason\":\"deadline-exceeded\"}";
  return answer.empty() ? unavailable() : answer;
}
void serve(const std::shared_ptr<Runtime>& state, Connection& connection) {
  Peer peer; bool leased = false, admitted = false;
  while (!stopped(*state)) {
    Wire request;
    if (!transfer(connection.pipe.value, &request, sizeof(request), false, state->stopping.value,
        admitted ? peer.process.value : nullptr, admitted ? 0 : GetTickCount64() + operation_bound)) break;
    if (!admitted) {
      ULONG pid = 0;
      if (!GetNamedPipeClientProcessId(connection.pipe.value, &pid) || !process_peer(pid, *state, peer)) break;
      // A new connection is a new lease incarnation even in the same process.
      // Its old queued EOF notice must not revoke a replacement connection.
      std::array<unsigned char, 32> nonce{};
      if (BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) break;
      peer.key = hash(peer.key + std::string(reinterpret_cast<const char*>(nonce.data()), nonce.size()));
      if (peer.key.size() != 64) break;
      admitted = true;
    }
    if (!from_client(connection.pipe.value, *state, peer) || !valid_request(request)) break;
    Wire reply; reply.operation = request.operation; reply.generation = request.generation; reply.sequence = request.sequence;
    std::memcpy(reply.window, request.window, sizeof(reply.window));
    if (request.operation == 0) {
      std::lock_guard guard(state->lock);
      reply.status = state->status_enabled ? 1 : 2;
      std::memcpy(reply.version, state->version.c_str(), state->version.size() + 1);
    } else {
      {
        std::lock_guard guard(state->lock);
        if (!leased) {
          if (!state->peers.count(peer.key) && state->peers.size() >= max_peers) break;
          ++state->peers[peer.key]; leased = true;
        }
      }
      const std::string payload = window_reply(*state, peer, request);
      if (payload.size() >= sizeof(reply.payload)) break;
      std::memcpy(reply.payload, payload.c_str(), payload.size() + 1);
    }
    if (!transfer(connection.pipe.value, &reply, sizeof(reply), true, state->stopping.value, peer.process.value, GetTickCount64() + operation_bound)) break;
  }
  if (leased) {
    { std::lock_guard guard(state->lock); const auto found = state->peers.find(peer.key); if (found != state->peers.end() && --found->second == 0) state->peers.erase(found); }
    auto notice = std::make_unique<Notice>(); notice->exited = true; notice->peer = peer.key; notify(*state, std::move(notice));
  }
  DisconnectNamedPipe(connection.pipe.value); connection.pipe.reset(); connection.finished = true;
}
Handle server_pipe(const Runtime& state, bool first) {
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), state.security, FALSE};
  return Handle(CreateNamedPipeW(state.endpoint.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    static_cast<DWORD>(max_connections + 2), sizeof(Wire), sizeof(Wire), operation_bound, &attributes));
}
void accept_connections(const std::shared_ptr<Runtime>& state, Handle first) {
  struct JoinedConnections {
    std::shared_ptr<Runtime> owner;
    std::vector<std::unique_ptr<Connection>> values;
    ~JoinedConnections() {
      SetEvent(owner->stopping.value);
      { std::lock_guard guard(owner->lock); for (const auto& entry : owner->pending) entry.second->changed.notify_all(); }
      for (auto& connection : values) if (connection->worker.joinable()) connection->worker.join();
    }
  } owned{state, {}};
  auto& connections = owned.values;
  connections.reserve(max_connections);
  Handle pipe = std::move(first);
  while (pipe && !stopped(*state)) {
    for (auto it = connections.begin(); it != connections.end();) {
      if ((*it)->finished) { (*it)->worker.join(); it = connections.erase(it); } else ++it;
    }
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event) break;
    OVERLAPPED pending{}; pending.hEvent = event.value;
    const BOOL connected = ConnectNamedPipe(pipe.value, &pending);
    const DWORD failure = connected ? ERROR_SUCCESS : GetLastError();
    if (!connected && failure != ERROR_PIPE_CONNECTED) {
      if (failure != ERROR_IO_PENDING) break;
      HANDLE waits[]{event.value, state->stopping.value};
      const DWORD ready = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
      if (ready != WAIT_OBJECT_0) { CancelIoEx(pipe.value, &pending); DWORD ignored = 0; GetOverlappedResult(pipe.value, &pending, &ignored, TRUE); break; }
      DWORD ignored = 0; if (!GetOverlappedResult(pipe.value, &pending, &ignored, FALSE)) break;
    }
    if (connections.size() >= max_connections) { DisconnectNamedPipe(pipe.value); continue; }
    auto connection = std::make_unique<Connection>(); connection->pipe = std::move(pipe);
    Connection* active = connection.get(); active->worker = std::thread([state, active] {
      try { serve(state, *active); }
      catch (...) { SetEvent(state->stopping.value); active->pipe.reset(); active->finished = true; }
    });
    connections.push_back(std::move(connection));
    pipe = server_pipe(*state, false);
  }
  // The scope joins every worker on success and on allocation/thread failure.
  // Each pending native read also waits on the shared stop event.
}

struct Answer { std::string kind = "refused", reason = "native-unavailable", version, payload; };
Answer ensure_server(const std::shared_ptr<Runtime>& state) {
  std::lock_guard guard(state->lifecycle);
  if (stopped(*state)) return {};
  if (state->acceptor.joinable()) return {"started", {}, {}, {}};
  Handle pipe = server_pipe(*state, true);
  if (!pipe || !private_pipe(pipe.value, *state)) return {};
  HANDLE retained = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), pipe.value, GetCurrentProcess(), &retained, 0, FALSE, DUPLICATE_SAME_ACCESS)) return {};
  state->admission = Handle(retained);
  state->acceptor = std::thread([state, first = std::move(pipe)]() mutable {
    try { accept_connections(state, std::move(first)); }
    catch (...) { SetEvent(state->stopping.value); }
  });
  return {"started", {}, {}, {}};
}
bool connect_client(Runtime& state, Handle& pipe, std::unique_ptr<Peer>& peer, ULONGLONG deadline) {
  while (!stopped(state) && GetTickCount64() < deadline) {
    pipe = Handle(CreateFileW(state.endpoint.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | SECURITY_CONTEXT_TRACKING, nullptr));
    if (pipe) break;
    const DWORD failure = GetLastError();
    if (failure != ERROR_PIPE_BUSY) return false;
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) return false;
    if (!WaitNamedPipeW(state.endpoint.c_str(), static_cast<DWORD>(std::min<ULONGLONG>(50, deadline - now))) && GetLastError() != ERROR_SEM_TIMEOUT) return false;
  }
  DWORD mode = PIPE_READMODE_MESSAGE; ULONG pid = 0;
  if (!pipe || !private_pipe(pipe.value, state) || !SetNamedPipeHandleState(pipe.value, &mode, nullptr, nullptr) || !GetNamedPipeServerProcessId(pipe.value, &pid)) return false;
  peer = std::make_unique<Peer>(); return process_peer(pid, state, *peer);
}
Answer exchange(Runtime& state, Handle& pipe, std::unique_ptr<Peer>& peer, const Wire& request, ULONGLONG deadline) {
  if (!peer || !live(*peer)) { pipe.reset(); peer.reset(); }
  if (!pipe && !connect_client(state, pipe, peer, deadline)) return {"refused", "not-running", {}, {}};
  Wire sent = request, reply;
  sent.sequence = state.next_sequence.fetch_add(1);
  if (sent.sequence == 0 || sent.sequence > safe_integer) return {};
  if (!transfer(pipe.value, &sent, sizeof(sent), true, state.stopping.value, peer->process.value, deadline)) {
    pipe.reset(); peer.reset(); return {"refused", "deadline-exceeded", {}, {}};
  }
  for (;;) {
    if (!transfer(pipe.value, &reply, sizeof(reply), false, state.stopping.value, peer->process.value, deadline)) {
      const DWORD failure = GetLastError();
      // Retain a healthy window connection after a late operation. Closing it
      // would revoke every other window belonging to this client.
      if (failure != ERROR_TIMEOUT || !live(*peer)) { pipe.reset(); peer.reset(); }
      return {"refused", failure == ERROR_TIMEOUT ? "deadline-exceeded" : "invalid-peer", {}, {}};
    }
    ULONG pid = 0;
    if (!live(*peer) || !GetNamedPipeServerProcessId(pipe.value, &pid) || pid != peer->pid ||
        reply.magic != sent.magic || reply.protocol != 1 || reply.sequence == 0 || reply.sequence > sent.sequence ||
        !std::memchr(reply.version, 0, sizeof(reply.version)) || !std::memchr(reply.payload, 0, sizeof(reply.payload))) {
      pipe.reset(); peer.reset(); return {"refused", "invalid-peer", {}, {}};
    }
    // A native sequence distinguishes successive renewals with the same public
    // window/generation; a late reply can never settle the following call.
    if (reply.sequence < sent.sequence) continue;
    if (reply.operation != sent.operation || reply.generation != sent.generation ||
        std::memcmp(reply.window, sent.window, sizeof(reply.window)) != 0) {
      pipe.reset(); peer.reset(); return {"refused", "invalid-receipt", {}, {}};
    }
    if (sent.operation == 0) return reply.status == 1 ? Answer{"ready", {}, reply.version, {}} : Answer{"refused", "not-running", {}, {}};
    if (reply.status != 0) return {"refused", "invalid-receipt", {}, {}};
    return {"ready", {}, {}, reply.payload};
  }
}
void close_runtime(const std::shared_ptr<Runtime>& state) {
  state->closed = true; SetEvent(state->stopping.value);
  { std::lock_guard guard(state->lock); state->status_enabled = false; state->windows_enabled = false; for (const auto& item : state->pending) item.second->changed.notify_all(); }
  { std::lock_guard guard(state->lifecycle); if (state->acceptor.joinable()) state->acceptor.join(); state->admission.reset(); }
  { std::lock_guard guard(state->client_lock); state->client_pipe.reset(); state->client_peer.reset(); }
  state->retired = true;
}
Answer close_status(const std::shared_ptr<Runtime>& state) {
  bool release = false;
  { std::lock_guard guard(state->lock); state->status_enabled = false; release = !state->windows_enabled; }
  if (release) close_runtime(state);
  return {"closed", {}, {}, {}};
}
Answer stop_windows(const std::shared_ptr<Runtime>& state) {
  bool release = false;
  {
    std::lock_guard guard(state->lock); state->windows_enabled = false;
    for (const auto& item : state->pending) item.second->changed.notify_all();
    release = !state->status_enabled;
  }
  if (release) close_runtime(state);
  return {"closed", {}, {}, {}};
}
// Retire old queued work permanently. A later operation uses a fresh binding,
// never a cleared stop event on the runtime whose connections just joined.
std::shared_ptr<Runtime> fresh_binding(const Runtime& previous) noexcept {
  try {
    auto state = std::make_shared<Runtime>(); HANDLE raw = nullptr;
    if (!state->stopping || !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return {};
    Handle token(raw);
    if (!token_principal(token.value, state->principal) || !same_principal(state->principal, previous.principal)) return {};
    const DWORD length = GetSecurityDescriptorLength(previous.security);
    if (length == 0 || length > 65536) return {};
    state->security = static_cast<PSECURITY_DESCRIPTOR>(LocalAlloc(LMEM_FIXED, length));
    if (!state->security) return {};
    std::memcpy(state->security, previous.security, length);
    state->profile = previous.profile; state->version = previous.version;
    state->endpoint = previous.endpoint; state->env = previous.env; state->thread = previous.thread;
    return state;
  } catch (...) { return {}; }
}
void cleanup(void* data) {
  const auto env = static_cast<napi_env>(data);
  std::shared_ptr<Runtime> state;
  { std::lock_guard guard(binding_lock); if (runtime && runtime->env == env) state = std::move(runtime); }
  if (!state) return;
  close_runtime(state);
  { std::lock_guard guard(state->lock); if (state->callback) { napi_release_threadsafe_function(state->callback, napi_tsfn_abort); state->callback = nullptr; } }
}
bool string_arg(napi_env env, napi_value input, std::string& out, size_t maximum) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, input, nullptr, 0, &length) != napi_ok || length > maximum) return false;
  out.resize(length + 1);
  if (napi_get_value_string_utf8(env, input, out.data(), out.size(), &length) != napi_ok) return false;
  out.resize(length); return out.find('\0') == std::string::npos;
}
napi_value bind_endpoint(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  std::string profile, version; bool accepted = false;
  if (count == 2 && main_thread() && string_arg(env, args[0], profile, 36) && uuid(profile) && string_arg(env, args[1], version, 63) &&
      valid_text(version, 63, "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-")) {
    std::lock_guard guard(binding_lock);
    if (runtime) accepted = runtime->env == env && runtime->profile == profile && runtime->version == version && !stopped(*runtime);
    else {
      auto state = std::make_shared<Runtime>(); HANDLE raw = nullptr; LPWSTR sid = nullptr;
      if (state->stopping && OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) {
        Handle token(raw);
        if (token_principal(token.value, state->principal) && ConvertSidToStringSidW(state->principal.sid.data(), &sid)) {
          const std::wstring sddl = L"O:" + std::wstring(sid) + L"G:" + sid + L"D:P(A;;FA;;;SY)(A;;FA;;;" + sid + L")";
          const std::string scope = profile + ":" + std::to_string(state->principal.session) + ":" +
            std::to_string(state->principal.logon.HighPart) + ":" + std::to_string(state->principal.logon.LowPart) + ":" +
            std::string(reinterpret_cast<const char*>(state->principal.sid.data()), state->principal.sid.size());
          const std::string identity = hash(scope);
          if (identity.size() == 64 && ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &state->security, nullptr)) {
            HMODULE module = nullptr;
            if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN, reinterpret_cast<LPCWSTR>(&module_anchor), &module)) {
              state->profile = profile; state->version = version; state->env = env; state->thread = GetCurrentThreadId();
              state->endpoint = L"\\\\.\\pipe\\Octant-desktop-" + std::wstring(identity.begin(), identity.end());
              runtime = state; accepted = true;
            }
          }
          LocalFree(sid);
        }
      }
    }
  }
  napi_value value; napi_get_boolean(env, accepted, &value); return value;
}
struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::shared_ptr<Runtime> state;
  std::string name, window;
  uint64_t generation = 0;
  ULONGLONG deadline = 0;
  Answer answer;
  std::atomic<bool>* busy = nullptr;
};
std::atomic<bool>& busy_flag(Runtime& state, const std::string& name) {
  if (name == "start") return state.start_pending;
  if (name == "status" || name == "launchStableHost") return state.status_pending;
  if (name == "listenWindows") return state.listen_pending;
  if (name == "stopWindows") return state.stop_pending;
  if (name == "close") return state.close_pending;
  return state.window_pending;
}
void execute(napi_env, void* data) {
  auto& job = *static_cast<Job*>(data);
  try {
    auto& state = *job.state;
    if (job.name == "start") {
      { std::lock_guard guard(state.lock); state.status_enabled = true; }
      job.answer = ensure_server(job.state);
    } else if (job.name == "listenWindows") job.answer = ensure_server(job.state);
    else if (job.name == "close") job.answer = close_status(job.state);
    else if (job.name == "stopWindows") job.answer = stop_windows(job.state);
    else if (job.name == "launchStableHost") job.answer = {"refused", "no-launcher-record", {}, {}};
    else if (job.name == "status") {
      Handle pipe; std::unique_ptr<Peer> peer; Wire request;
      job.answer = exchange(state, pipe, peer, request, job.deadline);
    } else {
      std::lock_guard guard(state.client_lock); Wire request;
      request.operation = job.name == "openWindow" ? 1 : job.name == "renewWindow" ? 2 : 3;
      request.generation = job.generation;
      std::memcpy(request.window, job.window.c_str(), job.window.size() + 1);
      std::memcpy(request.payload + 1, "native-main-v1", sizeof("native-main-v1"));
      job.answer = exchange(state, state.client_pipe, state.client_peer, request, job.deadline);
    }
  } catch (...) { job.answer = {}; }
}
void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Job> job(static_cast<Job*>(data));
  napi_value value;
  if (status == napi_ok && !job->answer.payload.empty()) {
    napi_value global, json, parse, input; napi_get_global(env, &global); napi_get_named_property(env, global, "JSON", &json); napi_get_named_property(env, json, "parse", &parse);
    napi_create_string_utf8(env, job->answer.payload.data(), job->answer.payload.size(), &input);
    if (napi_call_function(env, json, parse, 1, &input, &value) != napi_ok) {
      bool pending = false; napi_is_exception_pending(env, &pending); if (pending) { napi_value error; napi_get_and_clear_last_exception(env, &error); }
      value = result(env, "refused", "invalid-receipt");
    }
    SecureZeroMemory(job->answer.payload.data(), job->answer.payload.size());
  } else {
    value = result(env, status == napi_ok ? job->answer.kind : "refused", status == napi_ok ? job->answer.reason : "native-unavailable");
    if (job->answer.kind == "ready") { number(env, value, "protocol", 1); put(env, value, "version", job->answer.version); }
  }
  if (job->name == "close" || job->name == "stopWindows") {
    {
      std::lock_guard guard(job->state->lock);
      if (!job->state->windows_enabled && job->state->callback) {
        napi_release_threadsafe_function(job->state->callback, napi_tsfn_abort); job->state->callback = nullptr;
      }
    }
    if (status == napi_ok && job->answer.kind == "closed" && job->state->retired) {
      auto replacement = fresh_binding(*job->state);
      std::lock_guard guard(binding_lock);
      if (runtime == job->state && replacement) runtime = std::move(replacement);
    }
  }
  if (job->busy) *job->busy = false;
  napi_resolve_deferred(env, job->deferred, value); napi_delete_async_work(env, job->work);
}
napi_value operation(napi_env env, napi_callback_info info) {
  size_t count = 3; napi_value args[3]; void* raw = nullptr; napi_get_cb_info(env, info, &count, args, nullptr, &raw);
  auto job = std::make_unique<Job>(); job->name = static_cast<const char*>(raw); job->deadline = GetTickCount64() + operation_bound;
  napi_value promise; napi_create_promise(env, &job->deferred, &promise);
  { std::lock_guard guard(binding_lock); if (runtime && runtime->env == env && runtime->thread == GetCurrentThreadId()) job->state = runtime; }
  bool valid = job->state && (!stopped(*job->state) || job->name == "close");
  if (valid) {
    auto& busy = busy_flag(*job->state, job->name);
    valid = !busy.exchange(true);
    if (valid) job->busy = &busy;
  }
  if (job->name == "openWindow" || job->name == "renewWindow" || job->name == "revokeWindow") {
    double generation = 0;
    valid = valid && count == 2 && string_arg(env, args[0], job->window, 36) && uuid(job->window) &&
      napi_get_value_double(env, args[1], &generation) == napi_ok && generation >= 1 && generation <= static_cast<double>(safe_integer) && std::floor(generation) == generation;
    if (valid) job->generation = static_cast<uint64_t>(generation);
  } else if (job->name == "listenWindows") {
    napi_valuetype type;
    valid = valid && count == 1 && napi_typeof(env, args[0], &type) == napi_ok && type == napi_function;
    if (valid) {
      std::lock_guard guard(job->state->lock); napi_value resource; napi_create_string_utf8(env, "desktop-windows-peer", NAPI_AUTO_LENGTH, &resource);
      valid = !job->state->callback && napi_create_threadsafe_function(env, args[0], nullptr, resource, 32, 1, nullptr, nullptr, nullptr, callback, &job->state->callback) == napi_ok;
      if (valid) { napi_unref_threadsafe_function(env, job->state->callback); job->state->windows_enabled = true; }
    }
  } else valid = valid && count == 0;
  napi_value resource; napi_create_string_utf8(env, "desktop-windows-operation", NAPI_AUTO_LENGTH, &resource);
  if (!valid || napi_create_async_work(env, nullptr, resource, execute, complete, job.get(), &job->work) != napi_ok || napi_queue_async_work(env, job->work) != napi_ok) {
    if (job->work) napi_delete_async_work(env, job->work);
    if (job->busy) *job->busy = false;
    napi_resolve_deferred(env, job->deferred, result(env, "refused", "native-unavailable")); return promise;
  }
  job.release(); return promise;
}
napi_value reply_window(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr); bool accepted = false;
  std::shared_ptr<Runtime> state; { std::lock_guard guard(binding_lock); if (runtime && runtime->env == env && runtime->thread == GetCurrentThreadId()) state = runtime; }
  double id = 0;
  if (state && !stopped(*state) && count == 2 && napi_get_value_double(env, args[0], &id) == napi_ok && id >= 1 && id <= static_cast<double>(safe_integer) && std::floor(id) == id) {
    napi_value global, json, stringify, encoded; napi_get_global(env, &global); napi_get_named_property(env, global, "JSON", &json); napi_get_named_property(env, json, "stringify", &stringify);
    std::string payload;
    if (napi_call_function(env, json, stringify, 1, &args[1], &encoded) == napi_ok && string_arg(env, encoded, payload, 4095) && !payload.empty()) {
      std::lock_guard guard(state->lock); const auto found = state->pending.find(static_cast<ULONGLONG>(id));
      if (state->windows_enabled && found != state->pending.end()) {
        std::lock_guard answer(found->second->lock);
        if (!found->second->answered) { found->second->payload = std::move(payload); found->second->answered = true; found->second->changed.notify_all(); accepted = true; }
      }
    }
    bool pending = false; napi_is_exception_pending(env, &pending); if (pending) { napi_value error; napi_get_and_clear_last_exception(env, &error); }
  }
  napi_value value; napi_get_boolean(env, accepted, &value); return value;
}
napi_value init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, env);
  napi_property_descriptor binding{"bindEndpoint", nullptr, bind_endpoint, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &binding);
  for (const char* name : {"start", "status", "close", "listenWindows", "stopWindows", "openWindow", "renewWindow", "revokeWindow", "launchStableHost"}) {
    napi_property_descriptor method{name, nullptr, operation, nullptr, nullptr, nullptr, napi_default, const_cast<char*>(name)};
    napi_define_properties(env, exports, 1, &method);
  }
  napi_property_descriptor reply{"replyWindow", nullptr, reply_window, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &reply); return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
