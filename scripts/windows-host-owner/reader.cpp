#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value != nullptr && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
int refused(const char* stage) {
  const DWORD error = GetLastError();
  std::fprintf(stderr, "Owned reader setup refused at %s (%lu).\n", stage, error);
  return 2;
}
bool inherit_standard(DWORD name, Handle& output) {
  return DuplicateHandle(GetCurrentProcess(), GetStdHandle(name), GetCurrentProcess(),
    &output.value, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}
bool token_information(HANDLE token, TOKEN_INFORMATION_CLASS type, std::vector<unsigned char>& output) {
  DWORD needed = 0;
  GetTokenInformation(token, type, nullptr, 0, &needed);
  if (needed == 0 || needed > 65536) return false;
  output.resize(needed);
  return GetTokenInformation(token, type, output.data(), needed, &needed) != FALSE;
}
}

// QA only: the hosted runner enables debug privilege, which bypasses a process
// DACL. A restricted copy of this launcher's own token makes the owned denial
// fixture real without changing the runner, account or production binding.
int wmain(int argc, wchar_t** argv) {
  const bool profile_owner = argc > 1 && std::wcscmp(argv[1], L"--profile-user-owner") == 0;
  const int first = profile_owner ? 2 : 1;
  if (argc - first < 5 || argc - first > 6) return 2;
  std::wstring command;
  for (int i = first; i < argc; ++i) {
    const std::wstring argument(argv[i]);
    if (argument.empty() || argument.back() == L'\\' || argument.find_first_of(L"\"\r\n") != std::wstring::npos) return 2;
    if (!command.empty()) command += L' ';
    command += L'"' + argument + L'"';
  }
  if (command.size() > 32766) return 2;
  Handle original, restricted;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &original.value)) return refused("own-token");
  if (!CreateRestrictedToken(original.value, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 0, nullptr, &restricted.value)) return refused("restricted-token");
  if (profile_owner) {
    // Only this explicit persistent-profile probe needs a copied default owner.
    // The original handle keeps its old rights and is never adjusted.
    Handle adjustable;
    if (!DuplicateTokenEx(restricted.value, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
        nullptr, SecurityImpersonation, TokenPrimary, &adjustable.value)) return refused("adjustable-token-copy");
    std::vector<unsigned char> user, before, after, copied_owner;
    if (!token_information(adjustable.value, TokenUser, user) || !token_information(original.value, TokenOwner, before)) return refused("owned-token-identity");
    const auto user_identity = reinterpret_cast<const TOKEN_USER*>(user.data());
    TOKEN_OWNER expected_owner{user_identity->User.Sid};
    if (!SetTokenInformation(adjustable.value, TokenOwner, &expected_owner, sizeof(expected_owner)) ||
        !token_information(adjustable.value, TokenOwner, copied_owner) ||
        !EqualSid(reinterpret_cast<const TOKEN_OWNER*>(copied_owner.data())->Owner, expected_owner.Owner) ||
        !token_information(original.value, TokenOwner, after) ||
        !EqualSid(reinterpret_cast<const TOKEN_OWNER*>(before.data())->Owner, reinterpret_cast<const TOKEN_OWNER*>(after.data())->Owner)) return refused("copied-default-owner");
    CloseHandle(restricted.value); restricted.value = adjustable.value; adjustable.value = nullptr;
  }
  LUID debug{};
  PRIVILEGE_SET privileges{};
  privileges.PrivilegeCount = 1;
  privileges.Control = PRIVILEGE_SET_ALL_NECESSARY;
  privileges.Privilege[0].Attributes = SE_PRIVILEGE_ENABLED;
  BOOL enabled = TRUE;
  if (!LookupPrivilegeValueW(nullptr, SE_DEBUG_NAME, &debug)) return refused("debug-identity");
  privileges.Privilege[0].Luid = debug;
  if (!PrivilegeCheck(restricted.value, &privileges, &enabled) || enabled) return refused("restricted-debug-check");
  Handle job, input, output, error;
  job.value = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job.value == nullptr || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return refused("owned-job");
  if (!inherit_standard(STD_INPUT_HANDLE, input) || !inherit_standard(STD_OUTPUT_HANDLE, output) || !inherit_standard(STD_ERROR_HANDLE, error)) return refused("private-stdio");
  STARTUPINFOW start{};
  start.cb = sizeof(start);
  start.dwFlags = STARTF_USESTDHANDLES;
  start.hStdInput = input.value; start.hStdOutput = output.value; start.hStdError = error.value;
  PROCESS_INFORMATION created{};
  if (!CreateProcessAsUserW(restricted.value, argv[first], command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &start, &created)) return refused("restricted-process");
  Handle process, thread;
  process.value = created.hProcess; thread.value = created.hThread;
  if (!AssignProcessToJobObject(job.value, process.value)) {
    TerminateProcess(process.value, 2);
    WaitForSingleObject(process.value, 3000);
    return refused("owned-job-assignment");
  }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return refused("owned-resume");
  if (profile_owner) std::puts("{\"fixtureRestricted\":true,\"fixtureDefaultOwnerIsUser\":true,\"originalTokenOwnerUnchanged\":true}");
  else std::puts("{\"fixtureRestricted\":true}");
  const DWORD waited = WaitForSingleObject(process.value, 40000);
  DWORD result = 2;
  if (waited == WAIT_OBJECT_0) GetExitCodeProcess(process.value, &result);
  if (!TerminateJobObject(job.value, result)) return refused("owned-job-cleanup");
  const ULONGLONG deadline = GetTickCount64() + 3000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return refused("owned-job-joined");
    if (accounting.ActiveProcesses == 0) break;
    if (GetTickCount64() >= deadline) return refused("owned-job-deadline");
    Sleep(10);
  }
  std::puts("{\"ownedJobJoined\":true}");
  return result == 0 && waited == WAIT_OBJECT_0 ? 0 : 2;
}
