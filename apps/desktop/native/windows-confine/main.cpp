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
//     [--grant-read PATH | --grant-modify PATH]...
//     [--active-process-limit 1] --cwd PATH -- PROGRAM.exe [ARG]...
//   octant-windows-confine --full-access --cwd PATH -- PROGRAM.exe [ARG]...
//   octant-windows-confine --recover --container Octant.Confined.<32 hex>
//     [--grant-path PATH]...
//
// A refusal or setup failure exits 125 with one line on stderr; otherwise the
// exit code is the command's.
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <algorithm>
#include <cstdio>
#include <cwchar>
#include <cwctype>
#include <memory>
#include <string>
#include <vector>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif
#ifndef PROC_THREAD_ATTRIBUTE_HANDLE_LIST
#define PROC_THREAD_ATTRIBUTE_HANDLE_LIST ProcThreadAttributeValue(2, FALSE, TRUE, FALSE)
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
// One lock for every launcher in the session: each grant and removal reads a
// DACL and writes it back whole, so two launches editing the same checkout at
// once could each drop the other's entry, and one launch's cleanup could
// erase another's live grant.
constexpr wchar_t acl_mutex_name[] = L"Local\\octant-windows-confine-acl";
constexpr DWORD acl_lock_wait_ms = 60000;
constexpr DWORD job_drain_timeout_ms = 15000;

struct Grant {
  std::wstring path;
  DWORD mask;
};

struct Options {
  bool full_access = false;
  bool recover = false;
  std::wstring container;
  std::vector<std::wstring> capabilities;
  std::vector<Grant> grants;
  std::vector<std::wstring> recover_paths;
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
    if (flag == L"--recover") {
      options.recover = true;
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
    } else if (flag == L"--grant-path") {
      if (!drive_absolute(value)) return false;
      options.recover_paths.push_back(value);
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
  if (options.recover) {
    return !options.full_access && valid_container(options.container) && options.capabilities.empty() &&
      options.grants.empty() && options.active_process_limit == 0 && options.cwd.empty() && options.command.empty();
  }
  if (!options.recover_paths.empty()) return false;
  if (options.command.empty() || options.cwd.empty() || !drive_absolute(options.command[0])) return false;
  if (options.full_access) {
    // Full access is full access: nothing confining may ride along with it.
    return options.container.empty() && options.capabilities.empty() && options.grants.empty() &&
      options.active_process_limit == 0;
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

enum class Edit { applied, unnecessary, missing, linked, failed };

// Every component of a path, from the drive root down, held open while the
// launcher edits the object. Each is opened as itself (never followed) and
// without delete sharing, so none can be renamed or swapped for a junction
// between the check and the edit.
class HeldPath {
public:
  ~HeldPath() { release(); }
  void release() {
    for (HANDLE handle : handles_) CloseHandle(handle);
    handles_.clear();
  }
  HeldPath() = default;
  HeldPath(const HeldPath&) = delete;
  HeldPath& operator=(const HeldPath&) = delete;

  // A junction or link anywhere on the way down is refused: an ACE set
  // through `C:\alias\.aws`, with `C:\alias` a junction to the home folder,
  // would land on the real `.aws`, which the plan judged under another name.
  Edit hold(const std::wstring& path) {
    size_t next = 3;  // past `C:\`
    for (;;) {
      const size_t separator = path.find(L'\\', next);
      const std::wstring component = path.substr(0, separator == std::wstring::npos ? path.size() : separator);
      const std::wstring opened = component.size() == 2 ? component + L"\\" : component;
      HANDLE handle = CreateFileW(opened.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (handle == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? Edit::missing : Edit::failed;
      }
      handles_.push_back(handle);
      BY_HANDLE_FILE_INFORMATION information{};
      if (!GetFileInformationByHandle(handle, &information)) return Edit::failed;
      if ((information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Edit::linked;
      attributes_ = information.dwFileAttributes;
      if (separator == std::wstring::npos) break;
      next = separator + 1;
    }
    // The held leaf must be the very path asked for, under its long name, so
    // no alias the guard never spelled (an 8.3 name, a mount point) reaches it.
    std::wstring final_path(32768, L'\0');
    const DWORD length = GetFinalPathNameByHandleW(handles_.back(), final_path.data(),
      static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0 || length >= final_path.size()) return Edit::failed;
    final_path.resize(length);
    const std::wstring expected = L"\\\\?\\" + path;
    if (CompareStringOrdinal(final_path.c_str(), -1, expected.c_str(), -1, TRUE) != CSTR_EQUAL) return Edit::linked;
    return Edit::applied;
  }

  DWORD attributes() const { return attributes_; }

private:
  std::vector<HANDLE> handles_;
  DWORD attributes_ = 0;
};

struct Object {
  HeldPath held;
  DWORD attributes = 0;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  bool is_protected = false;
  ~Object() { if (descriptor != nullptr) LocalFree(descriptor); }
};

// Holds the session's ACL lock for one read-modify-write, from reading the
// DACL through writing it. A lock held by a launcher that died is taken over:
// each write is one SetNamedSecurityInfo call, so the DACL it left is whole.
// A lock that cannot be had in time refuses the edit rather than racing.
class AclLock {
public:
  AclLock() {
    mutex_ = CreateMutexW(nullptr, FALSE, acl_mutex_name);
    if (mutex_ == nullptr) return;
    const DWORD waited = WaitForSingleObject(mutex_, acl_lock_wait_ms);
    held_ = waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED;
  }
  ~AclLock() {
    if (held_) ReleaseMutex(mutex_);
    if (mutex_ != nullptr) CloseHandle(mutex_);
  }
  AclLock(const AclLock&) = delete;
  AclLock& operator=(const AclLock&) = delete;
  bool held() const { return held_; }

private:
  HANDLE mutex_ = nullptr;
  bool held_ = false;
};

// Reads one object's DACL with its whole path held (see HeldPath). A NULL
// DACL (everyone, everything) is refused.
Edit open_object(const std::wstring& path, Object& object) {
  const Edit held = object.held.hold(path);
  if (held != Edit::applied) return held;
  object.attributes = object.held.attributes();
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

// Removes every explicit entry naming `sid` by rewriting the object's
// explicit entries; inherited ones are left to the system, which re-merges
// them from the parent. Measured on Windows Server 2025: REVOKE_ACCESS left
// deny entries behind, and an explicit access-denied entry for the
// container's SID, listed ahead of its inherited grant, did not stop the
// container reading the file (cause not established), so the launcher writes
// no deny entries and the host refuses such a launch instead.
Edit remove_explicit(const std::wstring& path, PSID sid) {
  AclLock lock;
  if (!lock.held()) return Edit::failed;
  Object object;
  const Edit opened = open_object(path, object);
  if (opened != Edit::applied) return opened;
  DWORD size = sizeof(ACL);
  bool found = false;
  for (DWORD index = 0; index < object.dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(object.dacl, index, &raw)) return Edit::failed;
    const auto* header = static_cast<ACE_HEADER*>(raw);
    if ((header->AceFlags & INHERITED_ACE) == 0 && names_sid(header, sid)) {
      found = true;
    }
    size += header->AceSize;
  }
  // If grant_acl never wrote an explicit ACE for this container SID (for
  // example on a machine-managed read-only directory where ALL APPLICATION
  // PACKAGES already holds read access), skip SetNamedSecurityInfoW so
  // standard users do not need WRITE_DAC on paths they never modified.
  if (!found) return Edit::unnecessary;
  std::vector<unsigned char> buffer(size);
  auto* updated = reinterpret_cast<PACL>(buffer.data());
  const DWORD revision = object.dacl->AclRevision > ACL_REVISION ? object.dacl->AclRevision : ACL_REVISION;
  if (!InitializeAcl(updated, size, revision)) return Edit::failed;
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
  AclLock lock;
  if (!lock.held()) return Edit::failed;
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

  Edit grant(const Grant& grant) {
    const Edit edit = grant_acl(grant.path, sid_, grant.mask);
    if (edit == Edit::applied) edited_.push_back(grant.path);
    return edit;
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
      const Edit edit = remove_explicit(*it, sid_);
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

// Collects only the valid stdio handles and marks them inheritable so
// PROC_THREAD_ATTRIBUTE_HANDLE_LIST passes exclusively those handles to the
// child (never unrelated host handles).
std::vector<HANDLE> collect_standard_handles(STARTUPINFOW& startup) {
  startup.dwFlags |= STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  std::vector<HANDLE> inherited;
  for (HANDLE handle : {startup.hStdInput, startup.hStdOutput, startup.hStdError}) {
    if (handle == nullptr || handle == INVALID_HANDLE_VALUE) continue;
    if (std::find(inherited.begin(), inherited.end(), handle) != inherited.end()) continue;
    if (SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != FALSE) {
      inherited.push_back(handle);
    }
  }
  return inherited;
}

bool wait_for_job_empty(HANDLE job, HANDLE iocp, DWORD timeout_ms) {
  const ULONGLONG deadline = GetTickCount64() + timeout_ms;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) !=
          FALSE &&
        accounting.ActiveProcesses == 0) {
      return true;
    }
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) return false;
    const DWORD remaining = static_cast<DWORD>(deadline - now);
    DWORD message = 0;
    ULONG_PTR key = 0;
    LPOVERLAPPED overlapped = nullptr;
    if (!GetQueuedCompletionStatus(iocp, &message, &key, &overlapped, remaining)) {
      if (GetLastError() == WAIT_TIMEOUT) continue;
      return false;
    }
    if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO && key == reinterpret_cast<ULONG_PTR>(job)) {
      return true;
    }
  }
}

// Serialized, idempotent cleanup for a launch whose launcher was interrupted or
// ended before container.release() finished. Derives the exact container SID,
// removes only that SID's explicit ACEs under AclLock + HeldPath, and deletes
// the AppContainer profile. Unrelated ACLs and other live launches stay intact.
int recover_container(const Options& options) {
  PSID sid = nullptr;
  const HRESULT derived = DeriveAppContainerSidFromAppContainerName(options.container.c_str(), &sid);
  if (FAILED(derived) || sid == nullptr) {
    report(L"could not derive the AppContainer SID for recovery", static_cast<DWORD>(derived));
    return refused_exit;
  }
  bool clean = true;
  for (auto it = options.recover_paths.rbegin(); it != options.recover_paths.rend(); ++it) {
    const Edit edit = remove_explicit(*it, sid);
    if (edit == Edit::linked) {
      report(L"refused recovery on a path that passes through a junction or link");
      clean = false;
    } else if (edit != Edit::applied && edit != Edit::unnecessary && edit != Edit::missing) {
      report(L"could not remove a grant during recovery");
      clean = false;
    }
  }
  FreeSid(sid);
  const HRESULT deleted = DeleteAppContainerProfile(options.container.c_str());
  if (FAILED(deleted) && deleted != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) &&
      deleted != HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND)) {
    report(L"could not delete the AppContainer profile during recovery", static_cast<DWORD>(deleted));
    clean = false;
  }
  return clean ? 0 : refused_exit;
}

int run(const Options& options) {
  if (options.recover) return recover_container(options);

  Container container;
  HeldPath held_executable;
  if (!options.full_access) {
    const Edit exe_edit = held_executable.hold(options.command[0]);
    if (exe_edit == Edit::linked) {
      report(L"refused an executable whose path passes through a junction or link");
      return refused_exit;
    }
    if (exe_edit != Edit::applied || (held_executable.attributes() & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      report(L"could not verify the executable path; the launch was refused");
      return refused_exit;
    }
    if (!container.create(options)) return refused_exit;
    for (const auto& grant : options.grants) {
      const Edit edit = container.grant(grant);
      if (edit == Edit::linked) {
        report(L"refused a grant whose path passes through a junction or link");
        return refused_exit;
      }
      if (edit != Edit::applied && edit != Edit::unnecessary) {
        report(L"could not grant a folder to the container; the launch was refused");
        return refused_exit;
      }
    }
  }

  HANDLE job = make_job(options);
  if (job == nullptr) {
    report(L"could not create the job object", GetLastError());
    return refused_exit;
  }
  HANDLE iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1);
  if (iocp == nullptr) {
    report(L"could not create the job completion port", GetLastError());
    CloseHandle(job);
    return refused_exit;
  }
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT completion_port{job, iocp};
  if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &completion_port,
        sizeof(completion_port))) {
    report(L"could not associate the job completion port", GetLastError());
    CloseHandle(iocp);
    CloseHandle(job);
    return refused_exit;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  std::vector<HANDLE> inherited_handles = collect_standard_handles(startup.StartupInfo);

  const DWORD attribute_count = (options.full_access ? 1u : 2u) + (inherited_handles.empty() ? 0u : 1u);
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
  if (ok && !inherited_handles.empty()) {
    ok = UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles.data(),
           inherited_handles.size() * sizeof(HANDLE), nullptr, nullptr) != FALSE;
  }
  if (!ok) {
    report(L"could not prepare the process attributes", GetLastError());
    CloseHandle(iocp);
    CloseHandle(job);
    return refused_exit;
  }

  std::wstring command_line;
  for (const auto& argument : options.command) {
    if (!command_line.empty()) command_line.push_back(L' ');
    command_line += quote(argument);
  }
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const BOOL created = CreateProcessW(options.command[0].c_str(), command_line.data(), nullptr, nullptr,
    inherited_handles.empty() ? FALSE : TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, nullptr,
    options.cwd.c_str(), &startup.StartupInfo, &process);
  held_executable.release();
  if (!created) {
    report(L"could not start the command", GetLastError());
    DeleteProcThreadAttributeList(attributes);
    CloseHandle(iocp);
    CloseHandle(job);
    return refused_exit;
  }
  DeleteProcThreadAttributeList(attributes);
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = refused_exit;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);
  // End every remaining descendant in the job and wait for active process count
  // to reach zero before releasing ACLs and deleting the AppContainer profile.
  TerminateJobObject(job, exit_code);
  const bool drained = wait_for_job_empty(job, iocp, job_drain_timeout_ms);
  CloseHandle(job);
  CloseHandle(iocp);
  if (!drained) {
    report(L"job descendants did not exit before cleanup timeout");
  }
  const bool released = container.release();
  if (!released) report(L"a grant or the AppContainer profile could not be removed");
  if (!drained || !released) return refused_exit;
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
