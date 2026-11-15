// octant-windows-confine: the Windows counterpart of sandbox-exec and bwrap.
//
// It runs unconfined as the broker, starts one command inside a fresh
// AppContainer (deny-by-default: the container's SID reaches only objects
// whose DACL names it or ALL APPLICATION PACKAGES) and a kill-on-close job, and
// removes everything it added when the command ends. The server builds every
// argument from the shared confinement plan; this program trusts none of them
// beyond its own checks and refuses anything it cannot apply exactly.
//
//   octant-windows-confine --container Octant.Confined.<32 hex>
//     [--capability internetClient|privateNetworkClientServer]...
//     [--grant-read PATH | --grant-modify PATH]... [--deny PATH]...
//     [--active-process-limit 1] --cwd PATH -- PROGRAM.exe [ARG]...
//   octant-windows-confine --full-access --cwd PATH -- PROGRAM.exe [ARG]...
//
// A refusal or setup failure exits 125 with one line on stderr; otherwise the
// exit code is the command's.
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <cstdio>
#include <cwchar>
#include <cwctype>
#include <memory>
#include <string>
#include <vector>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

namespace {
constexpr int refused_exit = 125;
constexpr DWORD read_mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
constexpr DWORD modify_mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
constexpr wchar_t container_prefix[] = L"Octant.Confined.";
// Well-known capability SIDs, so no name derivation can resolve to another.
constexpr wchar_t internet_client_sid[] = L"S-1-15-3-1";
constexpr wchar_t private_network_sid[] = L"S-1-15-3-3";
constexpr wchar_t all_application_packages_sid[] = L"S-1-15-2-1";

struct Grant {
  std::wstring path;
  DWORD mask;
};

struct Options {
  bool full_access = false;
  std::wstring container;
  std::vector<std::wstring> capabilities;
  std::vector<Grant> grants;
  std::vector<std::wstring> denies;
  DWORD active_process_limit = 0;
  std::wstring cwd;
  std::vector<std::wstring> command;
};

void report(const wchar_t* what, DWORD error = ERROR_SUCCESS) {
  if (error == ERROR_SUCCESS) {
    std::fwprintf(stderr, L"octant-windows-confine: %ls\n", what);
  } else {
    std::fwprintf(stderr, L"octant-windows-confine: %ls (error %lu)\n", what, error);
  }
}

bool drive_absolute(const std::wstring& path) {
  return path.size() >= 3 && iswalpha(path[0]) && path[1] == L':' && path[2] == L'\\' &&
    path.find(L'/') == std::wstring::npos && path.find(L"\\\\") == std::wstring::npos;
}

bool valid_container(const std::wstring& name) {
  const size_t prefix = std::wcslen(container_prefix);
  if (name.size() != prefix + 32 || name.compare(0, prefix, container_prefix) != 0) return false;
  for (size_t i = prefix; i < name.size(); ++i) {
    const wchar_t c = name[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
  }
  return true;
}

bool parse(int argc, wchar_t** argv, Options& options) {
  int i = 1;
  for (; i < argc; ++i) {
    const std::wstring flag = argv[i];
    if (flag == L"--") {
      ++i;
      break;
    }
    if (flag == L"--full-access") {
      options.full_access = true;
      continue;
    }
    if (i + 1 >= argc) return false;
    const std::wstring value = argv[++i];
    if (flag == L"--container") {
      options.container = value;
    } else if (flag == L"--capability") {
      if (value == L"internetClient") options.capabilities.push_back(internet_client_sid);
      else if (value == L"privateNetworkClientServer") options.capabilities.push_back(private_network_sid);
      else return false;
    } else if (flag == L"--grant-read" || flag == L"--grant-modify") {
      if (!drive_absolute(value)) return false;
      options.grants.push_back({value, flag == L"--grant-read" ? read_mask : modify_mask});
    } else if (flag == L"--deny") {
      if (!drive_absolute(value)) return false;
      options.denies.push_back(value);
    } else if (flag == L"--active-process-limit") {
      if (value != L"1") return false;
      options.active_process_limit = 1;
    } else if (flag == L"--cwd") {
      if (!drive_absolute(value)) return false;
      options.cwd = value;
    } else {
      return false;
    }
  }
  for (; i < argc; ++i) options.command.emplace_back(argv[i]);
  if (options.command.empty() || options.cwd.empty() || !drive_absolute(options.command[0])) return false;
  if (options.full_access) {
    // Full access is full access: nothing confining may ride along with it.
    return options.container.empty() && options.capabilities.empty() && options.grants.empty() &&
      options.denies.empty() && options.active_process_limit == 0;
  }
  return valid_container(options.container);
}

// Windows argument quoting, the inverse of CommandLineToArgvW.
std::wstring quote(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) return argument;
  std::wstring quoted = L"\"";
  for (size_t i = 0;; ++i) {
    size_t backslashes = 0;
    while (i < argument.size() && argument[i] == L'\\') {
      ++i;
      ++backslashes;
    }
    if (i == argument.size()) {
      quoted.append(backslashes * 2, L'\\');
      break;
    }
    if (argument[i] == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
    } else {
      quoted.append(backslashes, L'\\');
    }
    quoted.push_back(argument[i]);
  }
  quoted.push_back(L'"');
  return quoted;
}

class Sid {
public:
  explicit Sid(const wchar_t* text) { ConvertStringSidToSidW(text, &sid_); }
  ~Sid() { if (sid_ != nullptr) LocalFree(sid_); }
  Sid(const Sid&) = delete;
  Sid& operator=(const Sid&) = delete;
  PSID get() const { return sid_; }

private:
  PSID sid_ = nullptr;
};

// Whether ALL APPLICATION PACKAGES already holds `mask` on the object, as it
// does on the system folders: such a grant writes nothing, so a program under
// System32 or Program Files runs without Octant editing a folder it does not own.
bool packages_already_hold(PACL dacl, DWORD mask) {
  if (dacl == nullptr) return false;
  Sid packages(all_application_packages_sid);
  if (packages.get() == nullptr) return false;
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  DWORD allowed = 0;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(dacl, index, &raw)) return false;
    const auto* header = static_cast<ACE_HEADER*>(raw);
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_DENIED_ACE*>(raw);
      if (EqualSid(const_cast<DWORD*>(&ace->SidStart), packages.get())) return false;
    } else if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      if (!EqualSid(const_cast<DWORD*>(&ace->SidStart), packages.get())) continue;
      DWORD granted = ace->Mask;
      MapGenericMask(&granted, &mapping);
      allowed |= granted;
    }
  }
  return (allowed & mask) == mask;
}

enum class Edit { applied, unnecessary, missing, failed };

struct Object {
  DWORD attributes = 0;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  bool is_protected = false;
  ~Object() { if (descriptor != nullptr) LocalFree(descriptor); }
};

// Reads one object's DACL. A reparse point is refused: an ACE set through a
// junction or link lands on whatever it points at, which the plan never
// judged. A NULL DACL (everyone, everything) is refused as well.
Edit open_object(const std::wstring& path, Object& object) {
  object.attributes = GetFileAttributesW(path.c_str());
  if (object.attributes == INVALID_FILE_ATTRIBUTES) {
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? Edit::missing : Edit::failed;
  }
  if ((object.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Edit::failed;
  if (GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &object.dacl,
        nullptr, &object.descriptor) != ERROR_SUCCESS || object.dacl == nullptr) {
    return Edit::failed;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(object.descriptor, &control, &revision)) return Edit::failed;
  object.is_protected = (control & SE_DACL_PROTECTED) != 0;
  return Edit::applied;
}

bool names_sid(const ACE_HEADER* header, PSID sid) {
  if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
    return EqualSid(const_cast<DWORD*>(&reinterpret_cast<const ACCESS_ALLOWED_ACE*>(header)->SidStart), sid) != FALSE;
  }
  if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
    return EqualSid(const_cast<DWORD*>(&reinterpret_cast<const ACCESS_DENIED_ACE*>(header)->SidStart), sid) != FALSE;
  }
  return false;
}

// Rewrites the object's explicit ACEs without any that name `sid`, with an
// explicit deny for it first when `deny` is set. Measured on Windows Server
// 2025: SetEntriesInAcl with DENY_ACCESS over an inherited grant for the same
// SID left an allow entry with no rights and no deny, so the inherited grant
// still read the file; and REVOKE_ACCESS leaves deny entries behind. Inherited
// entries are left to the system, which re-merges them from the parent.
Edit rewrite_explicit(const std::wstring& path, PSID sid, bool deny) {
  Object object;
  const Edit opened = open_object(path, object);
  if (opened != Edit::applied) return opened;
  const bool directory = (object.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  DWORD size = sizeof(ACL) + (deny ? sizeof(ACCESS_DENIED_ACE) - sizeof(DWORD) + GetLengthSid(sid) : 0);
  for (DWORD index = 0; index < object.dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(object.dacl, index, &raw)) return Edit::failed;
    size += static_cast<ACE_HEADER*>(raw)->AceSize;
  }
  std::vector<unsigned char> buffer(size);
  auto* updated = reinterpret_cast<PACL>(buffer.data());
  const DWORD revision = object.dacl->AclRevision > ACL_REVISION ? object.dacl->AclRevision : ACL_REVISION;
  if (!InitializeAcl(updated, size, revision)) return Edit::failed;
  if (deny && !AddAccessDeniedAceEx(updated, revision,
                directory ? static_cast<DWORD>(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : 0, FILE_ALL_ACCESS, sid)) {
    return Edit::failed;
  }
  for (DWORD index = 0; index < object.dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(object.dacl, index, &raw)) return Edit::failed;
    const auto* header = static_cast<ACE_HEADER*>(raw);
    if ((header->AceFlags & INHERITED_ACE) != 0 || names_sid(header, sid)) continue;
    if (!AddAce(updated, revision, MAXDWORD, raw, header->AceSize)) return Edit::failed;
  }
  const SECURITY_INFORMATION information = DACL_SECURITY_INFORMATION |
    (object.is_protected ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION);
  return SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, information, nullptr, nullptr,
           updated, nullptr) == ERROR_SUCCESS
    ? Edit::applied
    : Edit::failed;
}

// Adds the container's inheritable allow entry on one folder or file, unless
// ALL APPLICATION PACKAGES already holds that access there.
Edit grant_acl(const std::wstring& path, PSID sid, DWORD mask) {
  Object object;
  const Edit opened = open_object(path, object);
  if (opened != Edit::applied) return opened;
  if (packages_already_hold(object.dacl, mask)) return Edit::unnecessary;
  EXPLICIT_ACCESS_W access{};
  access.grfAccessPermissions = mask;
  access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance =
    (object.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL updated = nullptr;
  DWORD status = SetEntriesInAclW(1, &access, object.dacl, &updated);
  if (status == ERROR_SUCCESS) {
    status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
      nullptr, nullptr, updated, nullptr);
  }
  if (updated != nullptr) LocalFree(updated);
  return status == ERROR_SUCCESS ? Edit::applied : Edit::failed;
}

class Container {
public:
  ~Container() { release(); }

  bool create(const Options& options) {
    name_ = options.container;
    for (const auto& text : options.capabilities) capability_sids_.push_back(std::make_unique<Sid>(text.c_str()));
    for (const auto& sid : capability_sids_) {
      if (sid->get() == nullptr) return false;
      capabilities_.push_back({sid->get(), SE_GROUP_ENABLED});
    }
    // A fresh name every launch: an existing profile means the id was reused,
    // and its SID may already hold ACEs this launch never judged.
    const HRESULT result = CreateAppContainerProfile(name_.c_str(), name_.c_str(), L"Octant confined launch",
      capabilities_.empty() ? nullptr : capabilities_.data(), static_cast<DWORD>(capabilities_.size()), &sid_);
    if (FAILED(result)) {
      report(L"could not create the AppContainer profile", static_cast<DWORD>(result));
      sid_ = nullptr;
      return false;
    }
    created_ = true;
    return true;
  }

  bool grant(const Grant& grant) {
    const Edit edit = grant_acl(grant.path, sid_, grant.mask);
    if (edit == Edit::applied) edited_.push_back(grant.path);
    return edit == Edit::applied || edit == Edit::unnecessary;
  }

  bool deny(const std::wstring& path) {
    const Edit edit = rewrite_explicit(path, sid_, true);
    if (edit == Edit::applied) edited_.push_back(path);
    // Nothing exists there yet, so nothing is reachable through a grant.
    return edit == Edit::applied || edit == Edit::missing;
  }

  SECURITY_CAPABILITIES capabilities() {
    SECURITY_CAPABILITIES value{};
    value.AppContainerSid = sid_;
    value.Capabilities = capabilities_.empty() ? nullptr : capabilities_.data();
    value.CapabilityCount = static_cast<DWORD>(capabilities_.size());
    return value;
  }

  // Every ACE this launch added names only this container's SID; they and the
  // profile go when the command ends. A launcher killed outright leaves them,
  // naming a SID no later launch receives.
  bool release() {
    bool clean = true;
    for (auto it = edited_.rbegin(); it != edited_.rend(); ++it) {
      const Edit edit = rewrite_explicit(*it, sid_, false);
      if (edit != Edit::applied && edit != Edit::missing) {
        report(L"could not remove a grant");
        clean = false;
      }
    }
    edited_.clear();
    if (sid_ != nullptr) {
      FreeSid(sid_);
      sid_ = nullptr;
    }
    if (created_) {
      if (FAILED(DeleteAppContainerProfile(name_.c_str()))) clean = false;
      created_ = false;
    }
    capability_sids_.clear();
    capabilities_.clear();
    return clean;
  }

private:
  std::wstring name_;
  PSID sid_ = nullptr;
  bool created_ = false;
  std::vector<std::unique_ptr<Sid>> capability_sids_;
  std::vector<SID_AND_ATTRIBUTES> capabilities_;
  std::vector<std::wstring> edited_;
};

HANDLE make_job(const Options& options) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  // Closing the launcher's handle, however the launcher ends, ends every
  // process in the job: the Windows form of stopping a process group.
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (options.active_process_limit != 0) {
    // Plan and Chat may create no process; on Windows fork and exec are one call.
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = options.active_process_limit;
  }
  bool ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE;
  if (ok && !options.full_access) {
    JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
    ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
      JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_HANDLES |
      JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
    ok = SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui)) != FALSE;
  }
  if (!ok) {
    CloseHandle(job);
    return nullptr;
  }
  return job;
}

void inherit_standard_handles(STARTUPINFOW& startup) {
  startup.dwFlags |= STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  for (HANDLE handle : {startup.hStdInput, startup.hStdOutput, startup.hStdError}) {
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
      SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
  }
}

int run(const Options& options) {
  Container container;
  if (!options.full_access) {
    if (!container.create(options)) return refused_exit;
    for (const auto& grant : options.grants) {
      if (!container.grant(grant)) {
        report(L"could not grant a folder to the container; the launch was refused");
        return refused_exit;
      }
    }
    for (const auto& path : options.denies) {
      if (!container.deny(path)) {
        report(L"could not deny a protected file to the container; the launch was refused");
        return refused_exit;
      }
    }
  }

  HANDLE job = make_job(options);
  if (job == nullptr) {
    report(L"could not create the job object", GetLastError());
    return refused_exit;
  }

  const DWORD attribute_count = options.full_access ? 1 : 2;
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, attribute_count, 0, &size);
  std::vector<unsigned char> buffer(size);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer.data());
  SECURITY_CAPABILITIES capabilities = container.capabilities();
  // The job is assigned at creation, so no instruction of the command runs
  // outside it and no child it starts can escape it.
  bool ok = InitializeProcThreadAttributeList(attributes, attribute_count, 0, &size) != FALSE &&
    UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr) !=
      FALSE;
  if (ok && !options.full_access) {
    ok = UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities,
           sizeof(capabilities), nullptr, nullptr) != FALSE;
  }
  if (!ok) {
    report(L"could not prepare the process attributes", GetLastError());
    CloseHandle(job);
    return refused_exit;
  }

  std::wstring command_line;
  for (const auto& argument : options.command) {
    if (!command_line.empty()) command_line.push_back(L' ');
    command_line += quote(argument);
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes;
  inherit_standard_handles(startup.StartupInfo);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(options.command[0].c_str(), command_line.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, nullptr, options.cwd.c_str(),
        &startup.StartupInfo, &process)) {
    report(L"could not start the command", GetLastError());
    DeleteProcThreadAttributeList(attributes);
    CloseHandle(job);
    return refused_exit;
  }
  DeleteProcThreadAttributeList(attributes);
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = refused_exit;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);
  // The command's descendants end with it, as they do when a capsule's PID
  // namespace ends on Linux.
  TerminateJobObject(job, exit_code);
  CloseHandle(job);
  if (!container.release()) report(L"a grant or the AppContainer profile could not be removed");
  return static_cast<int>(exit_code);
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options options;
  if (!parse(argc, argv, options)) {
    report(L"refused malformed arguments");
    return refused_exit;
  }
  return run(options);
}
