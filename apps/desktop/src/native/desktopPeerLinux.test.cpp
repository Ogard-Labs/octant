// Linux client trust: the pure policy, then the real path socket with real
// processes. The standalone build has no Node API exports; it drives the
// production server loop and client calls directly.
#define OCTANT_PEER_LINUX_TEST
#include "desktopPeerLinux.cc"
#include <cstdlib>
#include <fstream>
#include <grp.h>
#include <iostream>
#include <iterator>
#include <limits.h>
#include <sstream>

namespace {
int checks = 0;
void check(bool value, const std::string &message) {
  ++checks;
  if (!value) {
    std::cerr << "FAILED: " << message << "\n";
    std::exit(2);
  }
}
bool required(const char *name) {
  const char *value = std::getenv(name);
  return value && std::string(value) == "1";
}
std::string self_path;
constexpr std::string_view LINUX_PEER_KEY_FIXTURE =
    "4be26660a400e0f5562c36dbe1d8253f815932426a83dde813a3cd721315422b";
void launcher_tests(const std::string &folder);

void policy_tests() {
  using namespace octant::desktop_peer_linux;
  const std::string folder = "/tmp/octant-1000";
  const std::string socket_path = folder + "/0123456789abcdef0123.windows.v1.sock";
  const std::string record = folder + "/0123456789abcdef0123.launcher.json";
  check(endpoint_paths(socket_path, record), "accepts the host-runtime endpoint pair");
  check(!endpoint_paths("relative.windows.v1.sock", record), "refuses a relative socket");
  check(!endpoint_paths(folder + "/../x/0123.windows.v1.sock", folder + "/0123.launcher.json"),
        "refuses a parent segment");
  check(!endpoint_paths(socket_path, "/elsewhere/0123456789abcdef0123.launcher.json"),
        "refuses a record in another folder");
  check(!endpoint_paths(folder + "/aaaa.windows.v1.sock", folder + "/bbbb.launcher.json"),
        "refuses mismatched identities");
  check(!endpoint_paths("/" + std::string(120, 'a') + "/0a.windows.v1.sock",
                        "/" + std::string(120, 'a') + "/0a.launcher.json"),
        "refuses a socket path longer than sun_path");

  struct stat directory{};
  directory.st_mode = S_IFDIR | 0700;
  directory.st_uid = 1000;
  check(private_directory(directory, 1000), "a private folder is accepted");
  directory.st_mode = S_IFDIR | 0750;
  check(!private_directory(directory, 1000), "a group-readable folder is refused");
  directory.st_mode = S_IFDIR | 0700;
  check(!private_directory(directory, 1001), "another person's folder is refused");
  directory.st_mode = S_IFLNK | 0700;
  check(!private_directory(directory, 1000), "a linked folder is refused");

  const auto start = process_start_time(
      "123 (a (b) c) S 1 123 123 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 1 2\n");
  check(start && *start == 98765, "reads start time after the last parenthesis");
  check(!process_start_time("123 (x) S 1 2"), "refuses a short stat line");
  check(fdinfo_pid("pos:\t0\nflags:\t02000002\nPid:\t4242\n") == 4242, "reads a pidfd pid");
  check(fdinfo_pid("Pid:\t-1\n") == -1, "reads an exited pidfd pid");
  check(!fdinfo_pid("flags:\t0\n"), "refuses fdinfo without a pid");
  // The same fixture key the desktop lease-owner test feeds to the real
  // JavaScript decoder; both sides must agree on it byte for byte.
  check(peer_key("00000000-0000-4000-8000-000000000001", 4242, 98765) ==
            LINUX_PEER_KEY_FIXTURE,
        "keys a peer by boot, pid and start time as SHA-256 hex");
  check(peer_key("00000000-0000-4000-8000-000000000001", 4242, 98766) !=
            LINUX_PEER_KEY_FIXTURE,
        "a new incarnation of the same pid gets a new key");
  check(sha256("abc")[0] == 0xba && sha256("abc")[31] == 0xad,
        "SHA-256 matches the FIPS 180-4 example");
  check(boot_id_text("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n") ==
            "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        "reads the boot id");
  check(!boot_id_text("short\n"), "refuses a malformed boot id");

  const auto parsed = parse_launcher_record(
      "{\"schemaVersion\":1,\"appImage\":\"/home/a/Octant \\\"x\\\".AppImage\","
      "\"device\":\"2049\",\"inode\":\"131\"}\n");
  check(parsed && parsed->app_image == "/home/a/Octant \"x\".AppImage" &&
            parsed->device == 2049 && parsed->inode == 131,
        "parses the record Octant writes");
  check(!parse_launcher_record("{\"schemaVersion\":1,\"appImage\":\"rel\",\"device\":\"1\","
                               "\"inode\":\"1\"}"),
        "refuses a relative image");
  check(!parse_launcher_record("{\"schemaVersion\":1,\"appImage\":\"/a\\u0000\",\"device\":\"1\","
                               "\"inode\":\"1\"}"),
        "refuses a Unicode escape");
  check(!parse_launcher_record("{\"schemaVersion\":1,\"appImage\":\"/a\",\"device\":\"01\","
                               "\"inode\":\"1\"}"),
        "refuses a padded number");
  check(!parse_launcher_record("{\"schemaVersion\":1,\"appImage\":\"/a\",\"device\":\"1\","
                               "\"inode\":\"1\",\"extra\":1}"),
        "refuses an extra field");

  LauncherRecord launcher{"/a", 5, 6};
  struct stat image{};
  image.st_mode = S_IFREG | 0755;
  image.st_uid = 1000;
  image.st_dev = 5;
  image.st_ino = 6;
  check(launcher_target(image, 1000, launcher), "accepts the recorded image");
  image.st_mode = S_IFREG | 0775;
  check(!launcher_target(image, 1000, launcher), "refuses a group-writable image");
  image.st_mode = S_IFREG | 0755;
  image.st_ino = 7;
  check(!launcher_target(image, 1000, launcher), "refuses a replaced image");
  image.st_ino = 6;
  check(!launcher_target(image, 0, launcher), "refuses another owner's image");
  struct stat record_file{};
  record_file.st_mode = S_IFREG | 0600;
  record_file.st_uid = 1000;
  record_file.st_size = 100;
  check(launcher_record_file(record_file, 1000), "accepts a private record");
  record_file.st_mode = S_IFREG | 0644;
  check(!launcher_record_file(record_file, 1000), "refuses a readable record");

  std::vector<std::string_view> environment = {
      "HOME=/home/a",       "DISPLAY=:0",          "LD_PRELOAD=/x.so",
      "APPIMAGE=/n.AppImage", "APPDIR=/tmp/.mount", "ELECTRON_RUN_AS_NODE=1",
      "NODE_OPTIONS=--require=/x", "LC_ALL=C",     "LC_lower=x",
      "OCTANT_DATA_DIR=/d", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"};
  const auto kept = launch_environment(environment);
  const std::vector<std::string> expected = {
      "HOME=/home/a", "DISPLAY=:0", "LC_ALL=C", "OCTANT_DATA_DIR=/d",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"};
  check(kept == expected, "keeps only the minimal launch environment");

  Wire status;
  bool native_main = true;
  check(valid_request(status, native_main) && !native_main, "accepts a status request");
  Wire window;
  window.operation = operation_register;
  window.generation = 1;
  std::memset(window.window, 'a', 36);
  check(valid_request(window, native_main) && !native_main, "accepts an original window request");
  std::memcpy(window.payload + 1, native_main_marker, sizeof(native_main_marker));
  check(valid_request(window, native_main) && native_main, "reads the native-main marker");
  std::memcpy(window.payload + 1, "other", 6);
  check(!valid_request(window, native_main), "refuses an unknown marker");
  window.payload[1] = 0;
  window.generation = 0;
  check(!valid_request(window, native_main), "refuses generation zero");
  window.generation = 1;
  window.operation = 9;
  check(!valid_request(window, native_main), "refuses an unknown operation");
  std::cout << "linux peer policy passed\n";
}

std::string make_private_folder() {
  char folder[] = "/tmp/octant-peer-test-XXXXXX";
  check(mkdtemp(folder) != nullptr, "temporary folder");
  check(chmod(folder, 0700) == 0, "private temporary folder");
  return folder;
}

void bind_test_endpoint(const std::string &folder) {
  std::lock_guard guard(endpoint.lock);
  endpoint.socket = folder + "/0123456789abcdef0123.windows.v1.sock";
  endpoint.record = folder + "/0123456789abcdef0123.launcher.json";
  endpoint.version = "1.2.3";
  endpoint.bound = true;
}

struct TestServer {
  std::shared_ptr<Server> owned = std::make_shared<Server>();
  std::mutex lock;
  std::condition_variable changed;
  std::vector<std::string> exited;
  unsigned requests = 0;
  bool silent_once = false;
  TestServer() {
    owned->status_enabled = true;
    owned->windows_enabled = true;
    auto *self = this;
    owned->deliver = [self](std::unique_ptr<Notice> notice) {
      std::lock_guard guard(self->lock);
      if (notice->exited)
        self->exited.push_back(notice->peer);
      else if (self->silent_once)
        self->silent_once = false;
      else {
        ++self->requests;
        std::lock_guard server_guard(self->owned->lock);
        auto found = self->owned->pending.find(notice->request);
        if (found != self->owned->pending.end()) {
          std::lock_guard pending_guard(found->second->lock);
          found->second->payload =
              "{\"kind\":\"registered\",\"peer\":\"" + notice->peer + "\"}";
          found->second->answered = true;
          found->second->changed.notify_all();
        }
      }
      self->changed.notify_all();
    };
  }
  bool start() { return ensure_server(owned).kind == "started"; }
  void stop() {
    owned->status_enabled = false;
    owned->windows_enabled = false;
    check(release_server(owned, Clock::now() + std::chrono::seconds(3)).kind == "closed",
          "server closes");
  }
  bool wait_exited(size_t count) {
    std::unique_lock guard(lock);
    return changed.wait_for(guard, std::chrono::seconds(3),
                            [&] { return exited.size() >= count; });
  }
};

// Connects and speaks without checking the server, as a hostile client would.
// Returns 0 when a reply arrived and 10 when the server refused by closing;
// other codes are setup failures, so a broken sandbox never passes as refusal.
int raw_status(const std::string &socket_path) {
  const int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
  if (fd < 0 || connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0)
    return 3;
  set_passcred(fd);
  Wire request;
  if (!send_wire(fd, request))
    return 5;
  pollfd watch{fd, POLLIN, 0};
  if (poll(&watch, 1, 3000) <= 0)
    return 4;
  Wire reply;
  const ssize_t count = recv(fd, &reply, sizeof(reply), 0);
  close(fd);
  return count == static_cast<ssize_t>(sizeof(reply)) ? 0 : count == 0 ? 10 : 6;
}

int run_child(const std::vector<std::string> &command) {
  const pid_t child = fork();
  if (child == 0) {
    std::vector<char *> argv;
    for (const auto &part : command)
      argv.push_back(const_cast<char *>(part.c_str()));
    argv.push_back(nullptr);
    execvp(argv[0], argv.data());
    _exit(127);
  }
  int status = 0;
  waitpid(child, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
}

bool command_exists(const std::string &name) {
  return run_child({"sh", "-c", "command -v " + name + " >/dev/null 2>&1"}) == 0;
}

void socket_tests() {
  const std::string folder = make_private_folder();
  bind_test_endpoint(folder);
  const std::string socket_path = endpoint.socket;

  // A stale socket from an exited Octant is unlinked under the lock; a file
  // that is not a socket, or a lock another owner holds, refuses.
  {
    const int stale = socket(AF_UNIX, SOCK_SEQPACKET, 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
    check(bind(stale, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0,
          "stale socket fixture");
    close(stale);
    const int holder = open((socket_path + ".lock").c_str(), O_RDWR | O_CREAT, 0600);
    check(holder >= 0 && flock(holder, LOCK_EX | LOCK_NB) == 0, "another owner locks");
    TestServer refused;
    check(!refused.start(), "refuses while another owner holds the lock");
    struct stat still{};
    check(lstat(socket_path.c_str(), &still) == 0 && S_ISSOCK(still.st_mode),
          "leaves the locked owner's socket in place");
    close(holder);
    unlink(socket_path.c_str());
    std::ofstream(socket_path) << "not a socket";
    TestServer wrong_file;
    check(!wrong_file.start(), "refuses a file that is not a socket");
    check(lstat(socket_path.c_str(), &still) == 0 && S_ISREG(still.st_mode),
          "never unlinks a file that is not a socket");
    unlink(socket_path.c_str());
    const int restale = socket(AF_UNIX, SOCK_SEQPACKET, 0);
    check(bind(restale, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0,
          "second stale fixture");
    close(restale);
  }
  chmod(folder.c_str(), 0750);
  {
    TestServer loose;
    check(!loose.start(), "refuses a runtime folder others can read");
  }
  chmod(folder.c_str(), 0700);

  for (bool fallback : {false, true}) {
    force_pidfd_open = fallback;
    const std::string mode = fallback ? " (pidfd_open fallback)" : " (SO_PEERPIDFD)";
    TestServer server;
    check(server.start(), "listens after unlinking a stale socket under the lock" + mode);
    struct stat metadata{};
    check(lstat(socket_path.c_str(), &metadata) == 0 && (metadata.st_mode & 0777) == 0600,
          "the socket is 0600" + mode);

    const auto status = query_status(Clock::now() + operation_bound);
    check(status.kind == "ready" && status.version == "1.2.3",
          "a same-user peer gets authenticated status" + mode + ": " + status.reason);

    // A same-user child registers a window, and its exit ends its leases even
    // while a grandchild still holds the connection open.
    int report[2];
    check(pipe(report) == 0, "report pipe");
    const pid_t child = fork();
    if (child == 0) {
      close(report[0]);
      window_client.reset();
      const auto payload = call_window(policy::operation_register,
                                       std::string(36, 'b'), 1,
                                       Clock::now() + operation_bound);
      const pid_t holder = fork();
      if (holder == 0) {
        sleep(10);
        _exit(0);
      }
      std::string self_stat;
      const int self_directory = open("/proc/self", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
      read_small(self_directory, "stat", self_stat, 4096);
      close(self_directory);
      const auto self_boot = own_boot_id();
      const auto self_start = policy::process_start_time(self_stat);
      const std::string own_key =
          self_boot && self_start ? policy::peer_key(*self_boot, getpid(), *self_start) : "";
      const std::string line =
          payload + "\n" + std::to_string(holder) + "\n" + own_key + "\n";
      if (write(report[1], line.data(), line.size()) < 0)
        _exit(3);
      _exit(0);
    }
    close(report[1]);
    std::string text;
    char buffer[4096];
    ssize_t count;
    while ((count = read(report[0], buffer, sizeof(buffer))) > 0)
      text.append(buffer, static_cast<size_t>(count));
    close(report[0]);
    int child_status = 0;
    waitpid(child, &child_status, 0);
    std::istringstream lines(text);
    std::string payload, holder_text;
    std::getline(lines, payload);
    std::getline(lines, holder_text);
    check(payload.find("\"kind\":\"registered\"") != std::string::npos,
          "a same-user client registers a window" + mode + ": " + payload);
    std::string expected_key;
    std::getline(lines, expected_key);
    check(expected_key.size() == 64 &&
              payload.find("\"peer\":\"" + expected_key + "\"") != std::string::npos,
          "the lease is keyed by the client's own boot, pid and start time" + mode);
    check(server.wait_exited(1) && server.exited.front() == expected_key,
          "the client's pidfd exit revokes its leases while its socket stays open" + mode);
    const pid_t holder = static_cast<pid_t>(std::stol(holder_text));
    kill(holder, SIGKILL);
    waitpid(holder, nullptr, 0);

    // A late answer refuses only its own call: the connection and the
    // client's other leases stay.
    window_client.reset();
    check(call_window(policy::operation_register, std::string(36, 'd'), 3,
                      Clock::now() + operation_bound)
                  .find("registered") != std::string::npos,
          "registers before a slow call" + mode);
    {
      std::lock_guard guard(server.lock);
      server.silent_once = true;
    }
    const auto late = call_window(policy::operation_renew, std::string(36, 'd'), 3,
                                  Clock::now() + std::chrono::milliseconds(300));
    check(late.find("deadline-exceeded") != std::string::npos,
          "a slow answer times out its own call" + mode + ": " + late);
    const auto after = call_window(policy::operation_renew, std::string(36, 'd'), 3,
                                   Clock::now() + std::chrono::seconds(5));
    check(after.find("registered") != std::string::npos,
          "the next call is answered on the same connection" + mode + ": " + after);
    {
      std::lock_guard guard(server.lock);
      check(server.exited.size() == 1, "a timeout revokes no lease" + mode);
    }
    // EOF on a window connection ends that peer's leases too.
    window_client.reset();
    const auto own = call_window(policy::operation_register, std::string(36, 'c'), 2,
                                 Clock::now() + operation_bound);
    check(own.find("registered") != std::string::npos, "the test process registers" + mode);
    window_client.reset();
    check(server.wait_exited(2), "closing the window connection revokes its leases" + mode);

    // A connection handed to another process cannot speak for its creator.
    int pair[2];
    check(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0, "socketpair");
    const pid_t receiver = fork();
    if (receiver == 0) {
      close(pair[0]);
      char byte;
      alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(int))];
      iovec vector{&byte, 1};
      msghdr message{};
      message.msg_iov = &vector;
      message.msg_iovlen = 1;
      message.msg_control = control;
      message.msg_controllen = sizeof(control);
      if (recvmsg(pair[1], &message, 0) != 1)
        _exit(5);
      int passed;
      std::memcpy(&passed, CMSG_DATA(CMSG_FIRSTHDR(&message)), sizeof(passed));
      Wire request;
      if (!send_wire(passed, request))
        _exit(5);
      pollfd watch{passed, POLLIN, 0};
      if (poll(&watch, 1, 3000) <= 0)
        _exit(4);
      Wire reply;
      const ssize_t count = recv(passed, &reply, sizeof(reply), 0);
      _exit(count == static_cast<ssize_t>(sizeof(reply)) ? 0 : count == 0 ? 10 : 6);
    }
    close(pair[1]);
    {
      const int connected = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
      sockaddr_un address{};
      address.sun_family = AF_UNIX;
      std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
      check(connect(connected, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0,
            "connect for the passed descriptor");
      set_passcred(connected);
      char byte = 0;
      alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(int))]{};
      iovec vector{&byte, 1};
      msghdr message{};
      message.msg_iov = &vector;
      message.msg_iovlen = 1;
      message.msg_control = control;
      message.msg_controllen = sizeof(control);
      cmsghdr *header = CMSG_FIRSTHDR(&message);
      header->cmsg_level = SOL_SOCKET;
      header->cmsg_type = SCM_RIGHTS;
      header->cmsg_len = CMSG_LEN(sizeof(int));
      std::memcpy(CMSG_DATA(header), &connected, sizeof(connected));
      check(sendmsg(pair[0], &message, 0) == 1, "pass the descriptor");
      close(connected);
    }
    int receiver_status = 0;
    waitpid(receiver, &receiver_status, 0);
    close(pair[0]);
    check(WIFEXITED(receiver_status) && WEXITSTATUS(receiver_status) == 10,
          "a descriptor passed with SCM_RIGHTS is refused" + mode);

    // A request that itself carries a descriptor is refused.
    {
      const int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
      sockaddr_un address{};
      address.sun_family = AF_UNIX;
      std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
      check(connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0,
            "connect with a right");
      set_passcred(fd);
      Wire request;
      alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(int))]{};
      iovec vector{&request, sizeof(request)};
      msghdr message{};
      message.msg_iov = &vector;
      message.msg_iovlen = 1;
      message.msg_control = control;
      message.msg_controllen = sizeof(control);
      cmsghdr *header = CMSG_FIRSTHDR(&message);
      header->cmsg_level = SOL_SOCKET;
      header->cmsg_type = SCM_RIGHTS;
      header->cmsg_len = CMSG_LEN(sizeof(int));
      const int carried = 0;
      std::memcpy(CMSG_DATA(header), &carried, sizeof(carried));
      check(sendmsg(fd, &message, MSG_NOSIGNAL) == static_cast<ssize_t>(sizeof(request)),
            "send with a right");
      pollfd watch{fd, POLLIN, 0};
      Wire reply;
      const bool answered = poll(&watch, 1, 3000) > 0 &&
                            recv(fd, &reply, sizeof(reply), 0) ==
                                static_cast<ssize_t>(sizeof(reply));
      close(fd);
      check(!answered, "a request carrying SCM_RIGHTS is refused" + mode);
    }

    // A peer in its own namespaces, even with the runtime folder bound in,
    // gets no answer.
    if (command_exists("bwrap")) {
      const int sandboxed =
          run_child({"bwrap", "--unshare-all", "--share-net", "--ro-bind", "/", "/",
                     "--dev-bind", "/dev", "/dev", "--bind", folder, folder, self_path,
                     "raw-client", socket_path});
      check(sandboxed == 10, "a bwrap --unshare-all peer is refused" + mode + " (exit " +
                                std::to_string(sandboxed) + ")");
      std::cout << "bwrap peer refused" << mode << "\n";
    } else
      check(!required("OCTANT_REQUIRE_LINUX_ISOLATION"), "bwrap is required here");

    // Another user. The runtime folder normally keeps them out; this serves a
    // world-reachable test socket so the kernel credential check is what refuses.
    {
      char open_folder[] = "/tmp/octant-peer-open-XXXXXX";
      check(mkdtemp(open_folder) != nullptr, "open folder");
      chmod(open_folder, 0755);
      const std::string open_socket = std::string(open_folder) + "/open.sock";
      const int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
      sockaddr_un address{};
      address.sun_family = AF_UNIX;
      std::memcpy(address.sun_path, open_socket.c_str(), open_socket.size() + 1);
      set_passcred(listener);
      check(bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0 &&
                chmod(open_socket.c_str(), 0777) == 0 && listen(listener, 4) == 0,
            "open listener");
      auto owned = std::make_shared<Server>();
      owned->status_enabled = true;
      owned->finished = false;
      std::thread worker(serve, owned, listener);
      int other = -1;
      if (geteuid() == 0) {
        const pid_t child = fork();
        if (child == 0) {
          if (setgroups(0, nullptr) != 0 || setresgid(65534, 65534, 65534) != 0 ||
              setresuid(65534, 65534, 65534) != 0)
            _exit(9);
          _exit(raw_status(open_socket));
        }
        int status = 0;
        waitpid(child, &status, 0);
        other = WIFEXITED(status) ? WEXITSTATUS(status) : 128;
      } else if (run_child({"sudo", "-n", "true"}) == 0) {
        other = run_child({"sudo", "-n", "-u", "nobody", self_path, "raw-client", open_socket});
      }
      if (other >= 0) {
        check(other == 10, "another user's peer is refused" + mode + " (exit " +
                              std::to_string(other) + ")");
        std::cout << "other-user peer refused" << mode << "\n";
      } else
        check(!required("OCTANT_REQUIRE_LINUX_ISOLATION"), "another user is required here");
      check(raw_status(open_socket) == 0, "the same user still gets an answer there");
      owned->stopping = true;
      worker.join();
      close(listener);
      unlink(open_socket.c_str());
      rmdir(open_folder);
    }
    server.stop();
    struct stat gone{};
    check(lstat(socket_path.c_str(), &gone) != 0, "close unlinks the owned socket" + mode);
    check(query_status(Clock::now() + operation_bound).reason == "not-running",
          "a closed Octant reads as not running" + mode);
  }
  force_pidfd_open = false;
  std::cout << "linux peer socket passed\n";
  launcher_tests(folder);
}

void write_record(const std::string &path, const std::string &image) {
  struct stat metadata{};
  check(stat(image.c_str(), &metadata) == 0, "image exists");
  const std::string temporary = path + ".tmp";
  {
    std::ofstream out(temporary);
    out << "{\"schemaVersion\":1,\"appImage\":\"" << image << "\",\"device\":\""
        << metadata.st_dev << "\",\"inode\":\"" << metadata.st_ino << "\"}\n";
  }
  chmod(temporary.c_str(), 0600);
  rename(temporary.c_str(), path.c_str());
}

bool wait_for_file(const std::string &path) {
  for (int attempt = 0; attempt < 200; ++attempt) {
    struct stat metadata{};
    if (stat(path.c_str(), &metadata) == 0 && metadata.st_size > 0)
      return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return false;
}

void launcher_tests(const std::string &folder) {
  const std::string record = endpoint.record;
  const std::string image = folder + "/Octant-test.AppImage";
  auto copy_self = [&](const std::string &to) {
    check(run_child({"cp", self_path, to}) == 0 && chmod(to.c_str(), 0755) == 0, "copy image");
  };
  const auto deadline = [] { return Clock::now() + operation_bound; };
  unlink(record.c_str());
  check(launch_stable_host(deadline()).reason == "no-launcher-record",
        "no record asks the person to open Octant");
  copy_self(image);
  write_record(record, image);
  const std::string landed = folder + "/launched.txt";
  setenv("HOME", folder.c_str(), 1);
  setenv("ELECTRON_RUN_AS_NODE", "1", 1);
  setenv("APPIMAGE", "/nightly.AppImage", 1);
  setenv("LD_PRELOAD", "", 1);
  const auto started = launch_stable_host(deadline());
  check(started.kind == "started", "starts the recorded image: " + started.reason);
  check(wait_for_file(landed), "the started image ran");
  std::ifstream in(landed);
  std::string launched((std::istreambuf_iterator<char>(in)), {});
  check(launched.find("arg:--octant-host-only\n") != std::string::npos,
        "starts it with the host-only role only");
  check(launched.find("env:HOME=") != std::string::npos &&
            launched.find("ELECTRON_RUN_AS_NODE") == std::string::npos &&
            launched.find("APPIMAGE=") == std::string::npos &&
            launched.find("LD_PRELOAD") == std::string::npos,
        "starts it with the minimal environment");
  unlink(landed.c_str());

  chmod(image.c_str(), 0775);
  check(launch_stable_host(deadline()).kind == "refused", "refuses a group-writable image");
  chmod(image.c_str(), 0755);
  const std::string moved = image + ".moved";
  rename(image.c_str(), moved.c_str());
  check(launch_stable_host(deadline()).kind == "refused", "refuses a moved image");
  copy_self(image);
  check(launch_stable_host(deadline()).kind == "refused", "refuses a replaced image");
  unlink(image.c_str());
  check(symlink(moved.c_str(), image.c_str()) == 0, "symlinked image");
  check(launch_stable_host(deadline()).kind == "refused", "refuses a symlinked image");
  unlink(image.c_str());
  rename(moved.c_str(), image.c_str());
  write_record(record, image);
  chmod(record.c_str(), 0644);
  check(launch_stable_host(deadline()).kind == "refused", "refuses a readable record");
  chmod(record.c_str(), 0600);
  const std::string real_record = record + ".real";
  rename(record.c_str(), real_record.c_str());
  check(symlink(real_record.c_str(), record.c_str()) == 0, "symlinked record");
  check(launch_stable_host(deadline()).kind == "refused", "refuses a symlinked record");
  check(!wait_for_file(landed), "no refused launch ran the image");
  std::cout << "linux launcher record passed\n";
}
} // namespace

int main(int argc, char **argv) {
  if (argc >= 2 && std::string(argv[1]) == "--octant-host-only") {
    // The launched "Octant": report what it was given, then exit.
    const char *home = std::getenv("HOME");
    if (!home)
      return 3;
    std::ofstream out(std::string(home) + "/launched.txt.tmp");
    for (int index = 1; index < argc; ++index)
      out << "arg:" << argv[index] << "\n";
    for (char **entry = environ; entry && *entry; ++entry)
      out << "env:" << *entry << "\n";
    out.close();
    rename((std::string(home) + "/launched.txt.tmp").c_str(),
           (std::string(home) + "/launched.txt").c_str());
    return 0;
  }
  if (argc == 3 && std::string(argv[1]) == "raw-client")
    return raw_status(argv[2]);
  alarm(120);
  char resolved[PATH_MAX];
  check(realpath("/proc/self/exe", resolved) != nullptr, "own path");
  self_path = resolved;
  policy_tests();
  socket_tests();
  std::cout << "linux peer checks: " << checks << "\n";
  return 0;
}
