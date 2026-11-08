#pragma once

constexpr size_t desktop_record_header = 40;
const std::array<unsigned char, 8> desktop_record_magic{'O','C','T','D','L','P','0','1'};
struct DesktopLauncherRecord { std::wstring image; FILE_ID_INFO identity{}; };
struct DesktopLauncherJob {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  decltype(&napi_remove_async_cleanup_hook) remove_cleanup = nullptr;
  std::string profile, scope, data, operation, status = "refused", reason = "native-unavailable";
  std::atomic<bool> cancelled = false;
  ULONGLONG deadline = 0, began = 0;
  size_t entries = 0;
};
DesktopLauncherJob* desktop_launcher_job = nullptr;
bool desktop_launcher_current(const DesktopLauncherJob& job) { return desktop_artifact_current(job.deadline, job.cancelled); }
bool decode_desktop_record(const Bytes& bytes, DesktopLauncherRecord& record) {
  if (bytes.size() < desktop_record_header || bytes.size() > authority_limit("desktop-launcher") ||
      !std::equal(desktop_record_magic.begin(), desktop_record_magic.end(), bytes.begin())) return false;
  DWORD length = 0, reserved = 0;
  std::memcpy(&record.identity.VolumeSerialNumber, bytes.data() + 8, 8);
  std::memcpy(record.identity.FileId.Identifier, bytes.data() + 16, 16);
  std::memcpy(&length, bytes.data() + 32, 4); std::memcpy(&reserved, bytes.data() + 36, 4);
  if (reserved != 0 || length == 0 || length >= 32768 || bytes.size() != desktop_record_header + static_cast<size_t>(length) * sizeof(wchar_t)) return false;
  record.image.resize(length); std::memcpy(record.image.data(), bytes.data() + desktop_record_header, static_cast<size_t>(length) * sizeof(wchar_t));
  std::wstring ordinary;
  return record.image.compare(0, 4, L"\\\\?\\") == 0 && desktop_image_path(record.image, ordinary);
}
Bytes encode_desktop_record(const DesktopArtifact& artifact) {
  Bytes bytes; bytes.resize(desktop_record_header + artifact.path.size() * sizeof(wchar_t));
  std::copy(desktop_record_magic.begin(), desktop_record_magic.end(), bytes.begin());
  std::memcpy(bytes.data() + 8, &artifact.identity.VolumeSerialNumber, 8);
  std::memcpy(bytes.data() + 16, artifact.identity.FileId.Identifier, 16);
  const DWORD length = static_cast<DWORD>(artifact.path.size());
  std::memcpy(bytes.data() + 32, &length, 4);
  std::memcpy(bytes.data() + desktop_record_header, artifact.path.data(), artifact.path.size() * sizeof(wchar_t));
  return bytes;
}
bool read_desktop_record(AuthoritySession& session, Bytes& bytes, const DesktopLauncherJob& job) {
  if (session.writing || session.length > authority_limit("desktop-launcher")) return false;
  bytes.resize(static_cast<size_t>(session.length));
  while (session.offset < session.length) {
    if (!desktop_launcher_current(job)) return false;
    const DWORD count = static_cast<DWORD>(std::min<ULONGLONG>(frame_limit, session.length - session.offset)); DWORD read = 0;
    if (!ReadFile(session.file.value, bytes.data() + static_cast<size_t>(session.offset), count, &read, nullptr) || read != count) return false;
    session.offset += read;
  }
  return authority_revalidate(session);
}
bool desktop_known_folder(REFKNOWNFOLDERID id, std::wstring& path) {
  PWSTR value = nullptr;
  const HRESULT result = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &value);
  if (FAILED(result) || !value) { if (value) CoTaskMemFree(value); return false; }
  path = value; CoTaskMemFree(value);
  return !path.empty() && path.size() < 32768;
}
bool desktop_environment(std::vector<wchar_t>& output) {
  std::vector<wchar_t> windows(32768); const UINT length = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  std::wstring home, local, roaming;
  if (length == 0 || length >= windows.size() || !desktop_known_folder(FOLDERID_Profile, home) ||
      !desktop_known_folder(FOLDERID_LocalAppData, local) || !desktop_known_folder(FOLDERID_RoamingAppData, roaming)) return false;
  const std::wstring system(windows.data(), length);
  std::vector<std::wstring> entries{L"APPDATA=" + roaming, L"LOCALAPPDATA=" + local,
    L"OCTANT_KEYCHAIN_SERVICE_FAMILY=octant", L"PATH=" + system + L"\\System32;" + system,
    L"SystemRoot=" + system, L"TEMP=" + local + L"\\Temp", L"TMP=" + local + L"\\Temp",
    L"USERPROFILE=" + home, L"WINDIR=" + system};
  std::sort(entries.begin(), entries.end(), [](const std::wstring& a, const std::wstring& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
  size_t total = 1;
  for (const auto& entry : entries) {
    if (entry.find(L'\0') != std::wstring::npos || entry.size() >= 32767 || total > 32767 - (entry.size() + 1)) return false;
    total += entry.size() + 1;
  }
  output.reserve(total);
  for (const auto& entry : entries) { output.insert(output.end(), entry.begin(), entry.end()); output.push_back(0); }
  output.push_back(0); return true;
}
void execute_desktop_launcher(napi_env, void* data) {
  auto& job = *static_cast<DesktopLauncherJob*>(data);
  try {
    if (!desktop_launcher_current(job)) { job.reason = "deadline-exceeded"; return; }
    std::unique_ptr<AuthoritySession> prior;
    DesktopLauncherRecord record;
    if (job.operation == "record") {
      std::vector<wchar_t> current(32768); const DWORD size = GetModuleFileNameW(nullptr, current.data(), static_cast<DWORD>(current.size()));
      if (size == 0 || size >= current.size()) { job.reason = "unsafe-artifact"; return; }
      record.image.assign(current.data(), size);
      std::wstring ordinary;
      if (!desktop_image_path(record.image, ordinary)) { job.reason = "unsafe-artifact"; return; }
      Guard guard;
      if (!authority_writer(job.env, job.scope)) { job.reason = "owner-unavailable"; return; }
      bool missing = false;
      prior = open_authority_file(job.env, job.profile, job.scope, job.data, "desktop-launcher", false, 0, missing);
      if (!prior && !missing) { job.reason = "profile-unavailable"; return; }
      if (prior) {
        Bytes bytes; DesktopLauncherRecord existing;
        if (!read_desktop_record(*prior, bytes, job) || !decode_desktop_record(bytes, existing)) { job.reason = desktop_launcher_current(job) ? "invalid-record" : "deadline-exceeded"; return; }
      }
    } else {
      Guard guard; bool missing = false;
      prior = open_authority_file(job.env, job.profile, job.scope, job.data, "desktop-launcher", false, 0, missing);
      if (!prior) { if (missing) { job.status = "missing"; job.reason.clear(); } else job.reason = "profile-unavailable"; return; }
      Bytes bytes;
      if (!read_desktop_record(*prior, bytes, job) || !decode_desktop_record(bytes, record)) { job.reason = desktop_launcher_current(job) ? "invalid-record" : "deadline-exceeded"; return; }
    }
    // The recursive public artifact inspection never holds the binding's SRW
    // lock; environment cleanup can cancel it and native owner polling continues.
    auto artifact = admit_desktop_artifact(record.image, job.deadline, job.cancelled, job.entries);
    if (!artifact) { job.reason = desktop_launcher_current(job) ? "unsafe-artifact" : "deadline-exceeded"; return; }
    job.entries = artifact->entries;
    if (job.operation == "record") {
      Bytes bytes = encode_desktop_record(*artifact);
      Guard guard;
      if (!desktop_launcher_current(job)) { job.reason = "deadline-exceeded"; return; }
      if (!authority_writer(job.env, job.scope)) { job.reason = "owner-unavailable"; return; }
      bool missing = false;
      auto write = open_authority_file(job.env, job.profile, job.scope, job.data, "desktop-launcher", true, bytes.size(), missing);
      if (!write) { job.reason = "profile-unavailable"; return; }
      while (write->offset < write->length) {
        if (!desktop_launcher_current(job)) { job.reason = "deadline-exceeded"; return; }
        const DWORD count = static_cast<DWORD>(std::min<ULONGLONG>(frame_limit, write->length - write->offset)); DWORD wrote = 0;
        if (!WriteFile(write->file.value, bytes.data() + static_cast<size_t>(write->offset), count, &wrote, nullptr) || wrote != count) return;
        write->offset += wrote;
      }
      if (!desktop_launcher_current(job)) { job.reason = "deadline-exceeded"; return; }
      if (!commit_authority_file(*write)) { job.reason = "profile-unavailable"; return; }
      job.status = "recorded"; job.reason.clear(); return;
    }
    if (artifact->identity.VolumeSerialNumber != record.identity.VolumeSerialNumber ||
        std::memcmp(artifact->identity.FileId.Identifier, record.identity.FileId.Identifier, 16) != 0 || artifact->path != record.image) { job.reason = desktop_launcher_current(job) ? "invalid-record" : "deadline-exceeded"; return; }
    { Guard guard; if (!authority_revalidate(*prior)) { job.reason = "profile-unavailable"; return; } }
    std::vector<wchar_t> environment;
    if (!desktop_environment(environment)) return;
    const size_t separator = artifact->path.find_last_of(L'\\');
    const std::wstring directory = artifact->path.substr(0, separator);
    std::wstring command = L"\"" + artifact->path + L"\" --octant-host-only";
    if (command.size() >= 32767 || !desktop_launcher_current(job)) { job.reason = "deadline-exceeded"; return; }
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION created{};
    if (!CreateProcessW(artifact->path.c_str(), command.data(), nullptr, nullptr, FALSE,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
        environment.data(), directory.c_str(), &startup, &created)) return;
    Handle process(created.hProcess), thread(created.hThread);
    const bool expired = !desktop_launcher_current(job);
    if (expired || ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
      const bool confirmed = TerminateProcess(process.value, 2) && WaitForSingleObject(process.value, 2500) == WAIT_OBJECT_0;
      job.reason = confirmed ? (expired ? "deadline-exceeded" : "native-unavailable") : "cleanup-unconfirmed"; return;
    }
    // No inherited transport or administrative seed enters this process. A
    // started receipt is not readiness; fresh native status/window admission is.
    job.status = "started"; job.reason.clear();
  } catch (...) { job.status = "refused"; job.reason = "native-unavailable"; }
}
void cleanup_desktop_launcher(napi_async_cleanup_hook_handle, void* data) {
  auto& job = *static_cast<DesktopLauncherJob*>(data);
  job.cancelled = true;
  napi_cancel_async_work(job.env, job.work);
}
void complete_desktop_launcher(napi_env env, napi_status status, void* data) {
  std::unique_ptr<DesktopLauncherJob> job(static_cast<DesktopLauncherJob*>(data));
  { Guard guard; if (desktop_launcher_job == job.get()) desktop_launcher_job = nullptr; }
  if (!job->cancelled) {
    napi_value value = object(env, status == napi_ok ? job->status.c_str() : "refused");
    if (!job->reason.empty()) put(env, value, "reason", status == napi_ok ? job->reason : "native-unavailable");
    safe_number(env, value, "elapsedMs", GetTickCount64() - job->began); safe_number(env, value, "scannedEntries", job->entries);
    napi_resolve_deferred(env, job->deferred, value);
  }
  napi_delete_async_work(env, job->work);
  if (job->cleanup && job->remove_cleanup) job->remove_cleanup(job->cleanup);
}
napi_value desktop_launcher(napi_env env, napi_callback_info info) {
  size_t count = 4; napi_value arguments[4]; napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
  auto job = std::make_unique<DesktopLauncherJob>(); job->env = env; job->began = GetTickCount64(); job->deadline = job->began + 2500;
  napi_value promise; napi_create_promise(env, &job->deferred, &promise);
  if (count == 4) { job->profile = string_arg(env, arguments[0]); job->scope = string_arg(env, arguments[1]); job->data = string_arg(env, arguments[2]); job->operation = string_arg(env, arguments[3]); }
  bool valid = job->profile == "octant" && uuid(job->scope) && !job->data.empty() && (job->operation == "record" || job->operation == "launch");
  {
    Guard guard;
    const auto found = profiles.find(job->profile);
    valid = valid && !desktop_launcher_job && found != profiles.end() && found->second->scope == job->scope &&
      (job->operation != "record" || authority_writer(env, job->scope));
    if (valid) desktop_launcher_job = job.get();
  }
  // A runtime without asynchronous environment cleanup cannot own queued
  // process creation safely. Refuse it before queuing any work.
  decltype(&napi_add_async_cleanup_hook) add_cleanup = nullptr;
  const FARPROC add = GetProcAddress(GetModuleHandleW(nullptr), "napi_add_async_cleanup_hook");
  const FARPROC remove = GetProcAddress(GetModuleHandleW(nullptr), "napi_remove_async_cleanup_hook");
  static_assert(sizeof(add_cleanup) == sizeof(add) && sizeof(job->remove_cleanup) == sizeof(remove));
  std::memcpy(&add_cleanup, &add, sizeof(add_cleanup)); std::memcpy(&job->remove_cleanup, &remove, sizeof(job->remove_cleanup));
  valid = valid && add_cleanup && job->remove_cleanup;
  napi_value resource; napi_create_string_utf8(env, "windows-desktop-launcher", NAPI_AUTO_LENGTH, &resource);
  if (!valid || napi_create_async_work(env, nullptr, resource, execute_desktop_launcher, complete_desktop_launcher, job.get(), &job->work) != napi_ok ||
      add_cleanup(env, cleanup_desktop_launcher, job.get(), &job->cleanup) != napi_ok || napi_queue_async_work(env, job->work) != napi_ok) {
    { Guard guard; if (desktop_launcher_job == job.get()) desktop_launcher_job = nullptr; }
    if (job->work) napi_delete_async_work(env, job->work);
    if (job->cleanup && job->remove_cleanup) job->remove_cleanup(job->cleanup);
    napi_resolve_deferred(env, job->deferred, object(env, "refused")); return promise;
  }
  job.release(); return promise;
}
