#include <windows.h>
#include <sddl.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {
struct Handle { HANDLE value = nullptr; ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
bool information(HANDLE token, TOKEN_INFORMATION_CLASS kind, std::vector<unsigned char>& bytes) {
  DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size);
  if (size == 0 || size > 65536) return false;
  bytes.resize(size); return GetTokenInformation(token, kind, bytes.data(), size, &size) != FALSE;
}
int refuse(const char* stage) { std::fprintf(stderr, "Owned peer launch refused at %s (%lu).\n", stage, GetLastError()); return 2; }
bool standard(DWORD name, Handle& result) {
  return DuplicateHandle(GetCurrentProcess(), GetStdHandle(name), GetCurrentProcess(), &result.value, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}
}
// Disposable QA only. Only copied child tokens are changed; the launcher's own
// token remains untouched. A held Job bounds every resulting process/descendant.
int wmain(int argc, wchar_t** argv) {
  if (argc < 7 || argc > 8) return 2;
  const bool restricting = std::wcscmp(argv[1], L"--restricting-sid") == 0;
  const bool low = std::wcscmp(argv[1], L"--low-integrity") == 0;
  if (!restricting && !low) return 2;
  std::wstring command;
  for (int i = 2; i < argc; ++i) {
    const std::wstring argument(argv[i]);
    if (argument.empty() || argument.back() == L'\\' || argument.find_first_of(L"\"\r\n") != std::wstring::npos) return 2;
    if (!command.empty()) command += L' ';
    command += L'"' + argument + L'"';
  }
  if (command.size() > 32766) return 2;
  Handle original, child;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &original.value)) return refuse("own-token");
  std::vector<unsigned char> user, before, after;
  if (!information(original.value, TokenUser, user) || !information(original.value, TokenIntegrityLevel, before)) return refuse("original-facts");
  if (restricting) {
    // A restriction to this user's own SID still passes its pipe DACL. The
    // production native predicate, rather than a missing ACL, must refuse it.
    SID_AND_ATTRIBUTES restricted{reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid, 0};
    if (!CreateRestrictedToken(original.value, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 1, &restricted, &child.value)) return refuse("restricting-token");
  } else {
    if (!DuplicateTokenEx(original.value, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
        nullptr, SecurityImpersonation, TokenPrimary, &child.value)) return refuse("low-token-copy");
    PSID sid = nullptr;
    if (!ConvertStringSidToSidW(L"S-1-16-4096", &sid)) return refuse("low-sid");
    TOKEN_MANDATORY_LABEL label{{sid, SE_GROUP_INTEGRITY}};
    const BOOL changed = SetTokenInformation(child.value, TokenIntegrityLevel, &label, static_cast<DWORD>(sizeof(label)) + GetLengthSid(sid));
    LocalFree(sid);
    if (!changed) return refuse("low-token-integrity");
  }
  DWORD size = 0, has_restrictions = 0, app_container = 1;
  std::vector<unsigned char> integrity;
  if (!GetTokenInformation(child.value, TokenHasRestrictions, &has_restrictions, sizeof(has_restrictions), &size) ||
      !GetTokenInformation(child.value, TokenIsAppContainer, &app_container, sizeof(app_container), &size) ||
      !information(child.value, TokenIntegrityLevel, integrity) || !information(original.value, TokenIntegrityLevel, after)) return refuse("copied-facts");
  const PSID level = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  const PSID original_level = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(before.data())->Label.Sid;
  const PSID after_level = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(after.data())->Label.Sid;
  if (!EqualSid(original_level, after_level) || !IsValidSid(level) || *GetSidSubAuthorityCount(level) == 0) return refuse("original-unchanged");
  const DWORD rid = *GetSidSubAuthority(level, static_cast<DWORD>(*GetSidSubAuthorityCount(level) - 1));
  const BOOL is_restricted = IsTokenRestricted(child.value);
  if ((restricting && !is_restricted) || (low && rid >= SECURITY_MANDATORY_MEDIUM_RID) || app_container) return refuse("intended-child-boundary");
  Handle job, input, output, error;
  job.value = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !standard(STD_INPUT_HANDLE, input) || !standard(STD_OUTPUT_HANDLE, output) || !standard(STD_ERROR_HANDLE, error)) return refuse("owned-job-stdio");
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = input.value; startup.hStdOutput = output.value; startup.hStdError = error.value;
  PROCESS_INFORMATION created{};
  if (!CreateProcessAsUserW(child.value, argv[2], command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &created)) return refuse("copied-child");
  Handle process, thread; process.value = created.hProcess; thread.value = created.hThread;
  if (!AssignProcessToJobObject(job.value, process.value)) { TerminateProcess(process.value, 2); WaitForSingleObject(process.value, 3000); return refuse("job-assignment"); }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) { TerminateJobObject(job.value, 2); WaitForSingleObject(process.value, 3000); return refuse("resume"); }
  std::printf("{\"restrictingSidList\":%s,\"tokenHasRestrictions\":%lu,\"appContainer\":false,\"integrityRid\":%lu,\"originalTokenUnchanged\":true}\n", is_restricted ? "true" : "false", has_restrictions, rid);
  const DWORD waited = WaitForSingleObject(process.value, 12000); DWORD result = 2;
  if (waited == WAIT_OBJECT_0) GetExitCodeProcess(process.value, &result);
  if (!TerminateJobObject(job.value, result)) return refuse("job-cleanup");
  const ULONGLONG deadline = GetTickCount64() + 3000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return refuse("joined-query");
    if (accounting.ActiveProcesses == 0) break;
    if (GetTickCount64() >= deadline) return refuse("joined-deadline");
    Sleep(10);
  }
  std::puts("{\"ownedPeerJobJoined\":true}");
  return waited == WAIT_OBJECT_0 && result == 0 ? 0 : 2;
}
