// Linux client trust between packaged Octant and Octant Nightly. Linux has no
// code signature or audit token to admit a desktop main by, so this binding
// admits a peer by what the kernel attests about the process on the other end
// of a path socket in the person's private runtime folder: the same user, the
// same mount, user and PID namespaces and root, and one process incarnation
// held through a pidfd. It exports the macOS binding's functions and wire
// semantics; the accepted limit is that same-user unconfined code can pass.
#include "desktopPeerLinuxPolicy.h"
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#ifndef OCTANT_PEER_LINUX_TEST
#include <node_api.h>
#endif
#include <poll.h>
#include <signal.h>
#include <string>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_execveat
#define SYS_execveat 322
#endif
#ifndef SYS_close_range
#define SYS_close_range 436
#endif
#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC 4
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif

extern char **environ;

namespace {
namespace policy = octant::desktop_peer_linux;
using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
constexpr auto operation_bound = std::chrono::milliseconds(2500);
using policy::Wire;

struct Result {
  std::string kind = "refused", reason = "native-unavailable", version;
};
bool expired(Deadline deadline) { return Clock::now() >= deadline; }
int remaining_ms(Deadline deadline) {
  const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                        deadline - Clock::now())
                        .count();
  return left <= 0 ? 0 : static_cast<int>(std::min<int64_t>(left, 60'000));
}

// Kernels before 6.5 have no SO_PEERPIDFD; the binding then opens a pidfd for
// the credential pid and binds it to the connection by the per-message
// kernel credential instead. The test build forces this path.
bool force_pidfd_open = false;

struct Endpoint {
  std::mutex lock;
  bool bound = false;
  std::string socket, record, version;
};
Endpoint endpoint;

bool endpoint_copy(std::string &socket, std::string &record,
                   std::string &version) {
  std::lock_guard guard(endpoint.lock);
  if (!endpoint.bound)
    return false;
  socket = endpoint.socket;
  record = endpoint.record;
  version = endpoint.version;
  return true;
}

bool private_runtime_directory(const std::string &path) {
  struct stat metadata{};
  return lstat(std::string(policy::parent_of(path)).c_str(), &metadata) == 0 &&
         policy::private_directory(metadata, geteuid());
}

bool read_small(int directory, const char *name, std::string &text,
                size_t cap) {
  const int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0)
    return false;
  text.clear();
  char buffer[1024];
  while (text.size() <= cap) {
    const ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) {
      close(fd);
      return false;
    }
    if (count == 0)
      break;
    text.append(buffer, static_cast<size_t>(count));
  }
  close(fd);
  return text.size() <= cap;
}

bool process_alive(int pidfd) {
  pollfd watch{pidfd, POLLIN, 0};
  // A readable pidfd means the process has exited.
  return poll(&watch, 1, 0) == 0;
}

bool same_object(int directory, const char *name, const char *own) {
  struct stat peer{}, self{};
  return fstatat(directory, name, &peer, 0) == 0 && stat(own, &self) == 0 &&
         peer.st_dev == self.st_dev && peer.st_ino == self.st_ino;
}

struct Peer {
  int pidfd = -1;
  int64_t pid = 0;
  std::string key;
  Peer() = default;
  Peer(const Peer &) = delete;
  Peer &operator=(const Peer &) = delete;
  Peer(Peer &&other) noexcept
      : pidfd(other.pidfd), pid(other.pid), key(std::move(other.key)) {
    other.pidfd = -1;
  }
  Peer &operator=(Peer &&other) noexcept {
    if (this != &other) {
      if (pidfd >= 0)
        close(pidfd);
      pidfd = other.pidfd;
      pid = other.pid;
      key = std::move(other.key);
      other.pidfd = -1;
    }
    return *this;
  }
  ~Peer() {
    if (pidfd >= 0)
      close(pidfd);
  }
};

// The process on the other end of a connected socket: same user, a pidfd for
// that incarnation, the same mount, user and PID namespaces and the same root.
// Everything read through /proc counts only while the pidfd shows the process
// alive, so a reused pid cannot answer for an exited peer.
bool validate_peer(int socket, Peer &peer, std::string &reason) {
  reason = "invalid-peer";
  ucred credentials{};
  socklen_t length = sizeof(credentials);
  if (getsockopt(socket, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 ||
      length != sizeof(credentials) || credentials.pid <= 0)
    return false;
  if (credentials.uid != geteuid()) {
    reason = "invalid-scope";
    return false;
  }
  int pidfd = -1;
  if (!force_pidfd_open) {
    length = sizeof(pidfd);
    if (getsockopt(socket, SOL_SOCKET, SO_PEERPIDFD, &pidfd, &length) != 0 ||
        length != sizeof(pidfd))
      pidfd = -1;
  }
  if (pidfd < 0)
    pidfd = static_cast<int>(syscall(SYS_pidfd_open, credentials.pid, 0));
  if (pidfd < 0) {
    reason = "native-unavailable";
    return false;
  }
  Peer candidate;
  candidate.pidfd = pidfd;
  fcntl(pidfd, F_SETFD, FD_CLOEXEC);
  std::string fdinfo;
  const int self_fdinfo =
      open("/proc/self/fdinfo", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (self_fdinfo < 0)
    return false;
  const bool fdinfo_read =
      read_small(self_fdinfo, std::to_string(pidfd).c_str(), fdinfo, 4096);
  close(self_fdinfo);
  const auto pid = fdinfo_read ? policy::fdinfo_pid(fdinfo) : std::nullopt;
  if (!pid || *pid != credentials.pid)
    return false;
  const std::string proc = "/proc/" + std::to_string(*pid);
  const int directory = open(proc.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0)
    return false;
  std::string stat_text;
  const bool same_scope = same_object(directory, "ns/mnt", "/proc/self/ns/mnt") &&
                          same_object(directory, "ns/user", "/proc/self/ns/user") &&
                          same_object(directory, "ns/pid", "/proc/self/ns/pid") &&
                          same_object(directory, "root", "/proc/self/root");
  const bool stat_read = read_small(directory, "stat", stat_text, 4096);
  close(directory);
  const auto start = stat_read ? policy::process_start_time(stat_text)
                               : std::nullopt;
  if (!process_alive(pidfd))
    return false;
  if (!same_scope) {
    reason = "invalid-scope";
    return false;
  }
  if (!start)
    return false;
  candidate.pid = *pid;
  candidate.key = policy::peer_key(*pid, *start);
  peer = std::move(candidate);
  return true;
}

void set_passcred(int socket) {
  const int on = 1;
  setsockopt(socket, SOL_SOCKET, SO_PASSCRED, &on, sizeof(on));
}

enum class Received { message, closed, refused, again };

// One whole message with its kernel credential. Passed descriptors are closed
// and refuse the connection: no right travels over this protocol.
Received receive_wire(int socket, Wire &wire, ucred &credentials) {
  alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(ucred)) +
                                         CMSG_SPACE(sizeof(int) * 8)];
  unsigned char buffer[sizeof(Wire) + 1];
  iovec vector{buffer, sizeof(buffer)};
  msghdr message{};
  message.msg_iov = &vector;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);
  const ssize_t count =
      recvmsg(socket, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  if (count < 0)
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR
               ? Received::again
               : Received::closed;
  bool rights = false, credential = false;
  for (cmsghdr *header = CMSG_FIRSTHDR(&message); header != nullptr;
       header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level != SOL_SOCKET)
      continue;
    if (header->cmsg_type == SCM_RIGHTS) {
      rights = true;
      const size_t descriptors =
          (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
      for (size_t index = 0; index < descriptors; ++index) {
        int fd;
        std::memcpy(&fd, CMSG_DATA(header) + index * sizeof(int), sizeof(fd));
        close(fd);
      }
    } else if (header->cmsg_type == SCM_CREDENTIALS &&
               header->cmsg_len == CMSG_LEN(sizeof(ucred))) {
      std::memcpy(&credentials, CMSG_DATA(header), sizeof(credentials));
      credential = true;
    }
  }
  if (count == 0)
    return Received::closed;
  if (rights || !credential || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) ||
      static_cast<size_t>(count) != sizeof(Wire))
    return Received::refused;
  std::memcpy(&wire, buffer, sizeof(Wire));
  return Received::message;
}

bool send_wire(int socket, const Wire &wire) {
  return send(socket, &wire, sizeof(wire), MSG_NOSIGNAL | MSG_DONTWAIT) ==
         static_cast<ssize_t>(sizeof(wire));
}

// A message counts only when the kernel says the process that sent it is the
// validated peer: a descriptor handed to another process cannot speak for it.
bool from_peer(const ucred &credentials, const Peer &peer) {
  return credentials.pid == peer.pid && credentials.uid == geteuid() &&
         process_alive(peer.pidfd);
}

struct Pending {
  std::mutex lock;
  std::condition_variable changed;
  std::string payload;
  bool answered = false;
  Deadline deadline;
};
struct Notice {
  std::string peer, window, operation;
  uint64_t request = 0, generation = 0;
  bool exited = false, native_main = false;
};

struct Server {
  std::mutex lock;
  std::atomic<bool> stopping = false, finished = true;
  bool status_enabled = false, windows_enabled = false;
  int listen_fd = -1, lock_fd = -1;
  std::string version;
  std::thread worker;
#ifndef OCTANT_PEER_LINUX_TEST
  napi_threadsafe_function callback = nullptr;
#else
  // The socket test answers window requests itself through this hook.
  std::function<void(std::unique_ptr<Notice>)> deliver;
#endif
  std::map<uint64_t, std::shared_ptr<Pending>> pending;
  uint64_t next_request = 1;
  ~Server() {
    if (worker.joinable())
      worker.detach();
  }
};
std::shared_ptr<Server> server = std::make_shared<Server>();
std::atomic<unsigned> operations = 0;

void emit(const std::shared_ptr<Server> &owned, std::unique_ptr<Notice> notice) {
#ifndef OCTANT_PEER_LINUX_TEST
  std::lock_guard guard(owned->lock);
  if (owned->stopping || !owned->windows_enabled)
    return;
  if (owned->callback &&
      napi_call_threadsafe_function(owned->callback, notice.get(),
                                    napi_tsfn_nonblocking) == napi_ok)
    notice.release();
#else
  std::function<void(std::unique_ptr<Notice>)> deliver;
  {
    std::lock_guard guard(owned->lock);
    if (owned->stopping || !owned->windows_enabled)
      return;
    deliver = owned->deliver;
  }
  if (deliver)
    deliver(std::move(notice));
#endif
}

struct Connection {
  int fd = -1;
  bool validated = false, windows = false;
  // A connection that never sends a valid first request is dropped.
  Deadline first_request = Clock::now() + operation_bound;
  Peer peer;
};

std::string refusal_payload(const char *reason) {
  return std::string("{\"kind\":\"refused\",\"reason\":\"") + reason + "\"}";
}

// Answers one request on a validated connection. Window requests block this
// loop until main answers or the deadline passes, as the macOS server does.
void answer(const std::shared_ptr<Server> &owned, Connection &connection,
            const Wire &request, bool native_main, Deadline deadline) {
  Wire reply;
  reply.operation = request.operation;
  reply.generation = request.generation;
  std::memcpy(reply.window, request.window, sizeof(reply.window));
  if (request.operation == policy::operation_status) {
    bool enabled;
    std::string version;
    {
      std::lock_guard guard(owned->lock);
      enabled = owned->status_enabled;
      version = owned->version;
    }
    reply.status = enabled ? policy::status_accepted : policy::status_refused;
    if (enabled)
      std::memcpy(reply.version, version.c_str(),
                  std::min(version.size(), sizeof(reply.version) - 1));
  } else {
    std::string payload = refusal_payload("invalid-request");
    connection.windows = true;
    auto pending = std::make_shared<Pending>();
    pending->deadline = deadline;
    uint64_t id = 0;
    bool listening;
    {
      std::lock_guard guard(owned->lock);
      listening = owned->windows_enabled && !owned->stopping;
      if (listening) {
        id = owned->next_request++;
        owned->pending.emplace(id, pending);
      }
    }
    if (listening) {
      auto notice = std::make_unique<Notice>();
      notice->request = id;
      notice->peer = connection.peer.key;
      notice->window = request.window;
      notice->generation = request.generation;
      notice->native_main = native_main;
      notice->operation = request.operation == policy::operation_register ? "register"
                          : request.operation == policy::operation_renew  ? "renew"
                                                                          : "revoke";
      emit(owned, std::move(notice));
      {
        std::unique_lock guard(pending->lock);
        pending->changed.wait_until(guard, deadline, [&] {
          return owned->stopping || pending->answered;
        });
        if (pending->answered && !expired(deadline))
          payload = pending->payload;
      }
      std::lock_guard guard(owned->lock);
      owned->pending.erase(id);
    }
    std::memcpy(reply.payload, payload.data(),
                std::min(payload.size(), sizeof(reply.payload) - 1));
  }
  if (!owned->stopping && !expired(deadline))
    send_wire(connection.fd, reply);
}

void serve(std::shared_ptr<Server> owned, int listener) {
  std::vector<Connection> connections;
  std::map<std::string, bool> peers;
  auto revoke = [&](const std::string &key) {
    if (key.empty())
      return;
    bool leased = false;
    for (auto it = connections.begin(); it != connections.end();) {
      if (it->validated && it->peer.key == key) {
        leased = leased || it->windows;
        close(it->fd);
        it = connections.erase(it);
      } else
        ++it;
    }
    if (peers.erase(key) != 0 || leased) {
      auto notice = std::make_unique<Notice>();
      notice->exited = true;
      notice->peer = key;
      emit(owned, std::move(notice));
    }
  };
  auto drop = [&](size_t index) {
    // EOF on a connection that carried window requests ends that peer's leases.
    if (connections[index].windows) {
      const std::string key = connections[index].peer.key;
      revoke(key);
      return;
    }
    close(connections[index].fd);
    connections.erase(connections.begin() + static_cast<long>(index));
  };
  while (!owned->stopping) {
    for (auto it = connections.begin(); it != connections.end();) {
      if (!it->validated && expired(it->first_request)) {
        close(it->fd);
        it = connections.erase(it);
      } else
        ++it;
    }
    std::vector<pollfd> watches;
    watches.push_back({listener, POLLIN, 0});
    for (auto &connection : connections) {
      watches.push_back({connection.fd, POLLIN, 0});
      watches.push_back({connection.validated ? connection.peer.pidfd : -1,
                         POLLIN, 0});
    }
    const int ready = poll(watches.data(), watches.size(), 100);
    if (ready < 0 && errno != EINTR)
      break;
    if (ready <= 0)
      continue;
    // Exited peers first: their leases end before any new request is read.
    std::vector<std::string> exited;
    for (size_t index = 0; index < connections.size(); ++index)
      if (connections[index].validated &&
          (watches[2 + index * 2].revents & (POLLIN | POLLHUP | POLLERR)))
        exited.push_back(connections[index].peer.key);
    for (const auto &key : exited)
      revoke(key);
    for (size_t index = 0; index < connections.size();) {
      const auto events = [&] {
        for (size_t at = 1; at < watches.size(); at += 2)
          if (watches[at].fd == connections[index].fd)
            return watches[at].revents;
        return short(0);
      }();
      if (!(events & (POLLIN | POLLHUP | POLLERR))) {
        ++index;
        continue;
      }
      Wire request;
      ucred credentials{};
      const auto received = receive_wire(connections[index].fd, request,
                                         credentials);
      if (received == Received::again) {
        ++index;
        continue;
      }
      if (received != Received::message) {
        drop(index);
        continue;
      }
      auto &connection = connections[index];
      const auto deadline = Clock::now() + operation_bound;
      bool native_main = false;
      if (!connection.validated) {
        std::string reason;
        Peer peer;
        if (!validate_peer(connection.fd, peer, reason)) {
          drop(index);
          continue;
        }
        connection.peer = std::move(peer);
        connection.validated = true;
      }
      if (!from_peer(credentials, connection.peer) ||
          !policy::valid_request(request, native_main)) {
        drop(index);
        continue;
      }
      if (request.operation != policy::operation_status &&
          !peers.contains(connection.peer.key)) {
        if (peers.size() >= policy::max_peers) {
          drop(index);
          continue;
        }
        peers.emplace(connection.peer.key, true);
      }
      answer(owned, connection, request, native_main, deadline);
      ++index;
    }
    if (watches[0].revents & POLLIN) {
      const int accepted = accept4(listener, nullptr, nullptr, SOCK_CLOEXEC);
      if (accepted >= 0) {
        if (connections.size() >= policy::max_peers * 2)
          close(accepted);
        else {
          set_passcred(accepted);
          Connection connection;
          connection.fd = accepted;
          connections.push_back(std::move(connection));
        }
      }
    }
  }
  for (auto &connection : connections)
    close(connection.fd);
  owned->finished = true;
}

// Listens on the path socket under the runtime folder's lock. A socket left
// by an exited Octant is unlinked only while holding that lock, so two hosts
// never unlink each other's endpoint.
Result ensure_server(const std::shared_ptr<Server> &owned) {
  std::string socket_path, record, version;
  if (!endpoint_copy(socket_path, record, version) ||
      !private_runtime_directory(socket_path))
    return {};
  std::lock_guard guard(owned->lock);
  if (owned->stopping)
    return {"refused", "deadline-exceeded", {}};
  if (owned->listen_fd >= 0)
    return {"started", {}, {}};
  const std::string lock_path = socket_path + ".lock";
  const int lock_fd = open(lock_path.c_str(),
                           O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  struct stat lock_metadata{};
  if (lock_fd < 0)
    return {};
  if (fstat(lock_fd, &lock_metadata) != 0 || !S_ISREG(lock_metadata.st_mode) ||
      lock_metadata.st_uid != geteuid() || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    close(lock_fd);
    return {};
  }
  struct stat existing{};
  if (lstat(socket_path.c_str(), &existing) == 0) {
    if (!S_ISSOCK(existing.st_mode) || existing.st_uid != geteuid() ||
        unlink(socket_path.c_str()) != 0) {
      close(lock_fd);
      return {};
    }
  }
  const int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
  set_passcred(listener);
  if (listener < 0 ||
      bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 ||
      chmod(socket_path.c_str(), 0600) != 0 || listen(listener, 8) != 0) {
    if (listener >= 0)
      close(listener);
    unlink(socket_path.c_str());
    close(lock_fd);
    return {};
  }
  owned->listen_fd = listener;
  owned->lock_fd = lock_fd;
  owned->version = version;
  owned->finished = false;
  try {
    owned->worker = std::thread(serve, owned, listener);
  } catch (...) {
    owned->listen_fd = -1;
    owned->lock_fd = -1;
    owned->finished = true;
    close(listener);
    unlink(socket_path.c_str());
    close(lock_fd);
    return {};
  }
  return {"started", {}, {}};
}

// Stops listening once neither status nor windows use the socket. Only the
// owner of the lock unlinks the path, so a replacement keeps its endpoint.
Result release_server(const std::shared_ptr<Server> &owned, Deadline deadline) {
  {
    std::lock_guard guard(owned->lock);
    if (owned->status_enabled || owned->windows_enabled || owned->listen_fd < 0)
      return {"closed", {}, {}};
    owned->stopping = true;
    for (const auto &[id, pending] : owned->pending) {
      (void)id;
      pending->changed.notify_all();
    }
  }
  while (!owned->finished && !expired(deadline))
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (!owned->finished)
    return {"failed", "deadline-exceeded", {}};
  std::lock_guard guard(owned->lock);
  if (owned->worker.joinable())
    owned->worker.join();
  std::string socket_path, record, version;
  if (endpoint_copy(socket_path, record, version))
    unlink(socket_path.c_str());
  close(owned->listen_fd);
  owned->listen_fd = -1;
  close(owned->lock_fd);
  owned->lock_fd = -1;
  return {"closed", {}, {}};
}

// The client side: connect to the path socket, then hold the server to the
// same kernel checks the server applies to the client.
struct Client {
  int fd = -1;
  Peer peer;
  ~Client() {
    if (fd >= 0)
      close(fd);
  }
};

Result connect_server(Client &client, Deadline deadline) {
  std::string socket_path, record, version;
  if (!endpoint_copy(socket_path, record, version))
    return {};
  if (!private_runtime_directory(socket_path))
    return {"refused", "not-running", {}};
  struct stat metadata{};
  if (lstat(socket_path.c_str(), &metadata) != 0)
    return {"refused", "not-running", {}};
  if (!S_ISSOCK(metadata.st_mode) || metadata.st_uid != geteuid())
    return {"refused", "invalid-peer", {}};
  client.fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  if (client.fd < 0)
    return {};
  set_passcred(client.fd);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, socket_path.c_str(), socket_path.size() + 1);
  if (connect(client.fd, reinterpret_cast<sockaddr *>(&address),
              sizeof(address)) != 0)
    return {"refused",
            errno == ECONNREFUSED || errno == ENOENT ? "not-running"
                                                     : "native-unavailable",
            {}};
  std::string reason;
  if (!validate_peer(client.fd, client.peer, reason))
    return {"refused", reason, {}};
  if (expired(deadline))
    return {"refused", "deadline-exceeded", {}};
  return {"ready", {}, {}};
}

Result exchange(Client &client, const Wire &request, Wire &reply,
                Deadline deadline) {
  if (!send_wire(client.fd, request))
    return {"refused", "not-running", {}};
  for (;;) {
    pollfd watch{client.fd, POLLIN, 0};
    const int ready = poll(&watch, 1, remaining_ms(deadline));
    if (ready < 0 && errno == EINTR)
      continue;
    if (ready <= 0)
      return {"refused", "deadline-exceeded", {}};
    ucred credentials{};
    const auto received = receive_wire(client.fd, reply, credentials);
    if (received == Received::again)
      continue;
    if (received == Received::closed)
      return {"refused", "invalid-peer", {}};
    if (received != Received::message || !from_peer(credentials, client.peer) ||
        !policy::valid_reply(reply, request))
      return {"refused", "invalid-peer", {}};
    return {"ready", {}, {}};
  }
}

Result query_status(Deadline deadline) {
  Client client;
  Result connected = connect_server(client, deadline);
  if (connected.kind != "ready")
    return connected;
  Wire request, reply;
  Result exchanged = exchange(client, request, reply, deadline);
  if (exchanged.kind != "ready")
    return exchanged;
  if (reply.status != policy::status_accepted ||
      !policy::version_text(reply.version))
    return {"refused", reply.status == policy::status_refused ? "not-running"
                                                              : "invalid-peer",
            {}};
  return {"ready", {}, reply.version};
}

// The window connection stays open: its EOF tells the server this client's
// leases end, beside the pidfd exit it also watches.
std::mutex window_client_lock;
std::unique_ptr<Client> window_client;

std::string call_window(uint32_t operation, const std::string &window,
                        uint64_t generation, Deadline deadline) {
  std::lock_guard guard(window_client_lock);
  Wire request;
  request.operation = operation;
  request.generation = generation;
  std::memcpy(request.window, window.c_str(), window.size() + 1);
  std::memcpy(request.payload + 1, policy::native_main_marker,
              sizeof(policy::native_main_marker));
  for (int attempt = 0; attempt < 2; ++attempt) {
    if (!window_client || !process_alive(window_client->peer.pidfd)) {
      window_client = std::make_unique<Client>();
      const Result connected = connect_server(*window_client, deadline);
      if (connected.kind != "ready") {
        window_client.reset();
        return refusal_payload(connected.reason.c_str());
      }
    }
    Wire reply;
    const Result exchanged = exchange(*window_client, request, reply, deadline);
    if (exchanged.kind == "ready")
      return reply.payload;
    window_client.reset();
    if (exchanged.reason != "not-running")
      return refusal_payload(exchanged.reason.c_str());
  }
  return refusal_payload("not-running");
}

// Starts a closed Octant from the launcher record its last packaged launch
// wrote: the exact AppImage inode, run by descriptor with the host-only role
// and a minimal environment. A missing record asks the person to open Octant.
Result launch_stable_host(Deadline deadline) {
  std::string socket_path, record_path, version;
  if (!endpoint_copy(socket_path, record_path, version))
    return {};
  if (!private_runtime_directory(record_path))
    return {"refused", "no-launcher-record", {}};
  const int record_fd =
      open(record_path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (record_fd < 0)
    return {"refused", errno == ENOENT ? "no-launcher-record" : "invalid-peer", {}};
  struct stat record_metadata{};
  std::string text;
  bool readable = fstat(record_fd, &record_metadata) == 0 &&
                  policy::launcher_record_file(record_metadata, geteuid());
  if (readable) {
    text.resize(static_cast<size_t>(record_metadata.st_size));
    readable = pread(record_fd, text.data(), text.size(), 0) ==
               static_cast<ssize_t>(text.size());
  }
  close(record_fd);
  const auto record = readable ? policy::parse_launcher_record(text) : std::nullopt;
  if (!record)
    return {"refused", "invalid-peer", {}};
  const int image = open(record->app_image.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat image_metadata{};
  if (image < 0 || fstat(image, &image_metadata) != 0 ||
      !policy::launcher_target(image_metadata, geteuid(), *record)) {
    if (image >= 0)
      close(image);
    return {"refused", "invalid-peer", {}};
  }
  std::vector<std::string_view> inherited;
  for (char **entry = environ; entry && *entry; ++entry)
    inherited.emplace_back(*entry);
  const auto kept = policy::launch_environment(inherited);
  std::vector<char *> envp;
  for (const auto &entry : kept)
    envp.push_back(const_cast<char *>(entry.c_str()));
  envp.push_back(nullptr);
  std::string argument0 = record->app_image, role = "--octant-host-only";
  char *argv[] = {argument0.data(), role.data(), nullptr};
  int report[2];
  if (pipe2(report, O_CLOEXEC) != 0) {
    close(image);
    return {};
  }
  // Prepared before fork: the children only make system calls.
  const pid_t child = fork();
  if (child < 0) {
    close(image);
    close(report[0]);
    close(report[1]);
    return {};
  }
  if (child == 0) {
    setsid();
    const pid_t grandchild = fork();
    if (grandchild != 0)
      _exit(grandchild < 0 ? 1 : 0);
    const int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null >= 0) {
      dup2(null, 0);
      dup2(null, 1);
      dup2(null, 2);
    }
    // Nothing of Nightly's but the image itself reaches Octant.
    syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC);
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, nullptr);
    syscall(SYS_execveat, image, "", argv, envp.data(), AT_EMPTY_PATH);
    const int failure = errno;
    if (write(report[1], &failure, sizeof(failure)) < 0)
      _exit(127);
    _exit(127);
  }
  close(image);
  close(report[1]);
  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {
  }
  int failure = 0;
  pollfd watch{report[0], POLLIN, 0};
  ssize_t count = 0;
  if (poll(&watch, 1, remaining_ms(deadline)) > 0)
    count = read(report[0], &failure, sizeof(failure));
  close(report[0]);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 || count != 0)
    return {"refused", "invalid-peer", {}};
  if (expired(deadline))
    return {"refused", "deadline-exceeded", {}};
  return {"started", {}, {}};
}

Result start_status() {
  {
    std::lock_guard guard(server->lock);
    if (server->stopping)
      return {"refused", "deadline-exceeded", {}};
    server->status_enabled = true;
  }
  Result result = ensure_server(server);
  if (result.kind != "started") {
    std::lock_guard guard(server->lock);
    server->status_enabled = false;
  }
  return result;
}

Result close_status(Deadline deadline) {
  {
    std::lock_guard guard(server->lock);
    server->status_enabled = false;
  }
  while (operations.load() != 0 && !expired(deadline))
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (operations.load() != 0)
    return {"failed", "deadline-exceeded", {}};
  return release_server(server, deadline);
}

#ifndef OCTANT_PEER_LINUX_TEST
bool main_thread() { return gettid() == getpid(); }

void set(napi_env env, napi_value object, const char *key,
         const std::string &text) {
  napi_value value;
  napi_create_string_utf8(env, text.data(), text.size(), &value);
  napi_set_named_property(env, object, key, value);
}

void resolve_result(napi_env env, napi_deferred deferred, const Result &result) {
  napi_value value;
  napi_create_object(env, &value);
  set(env, value, "kind", result.kind);
  if (!result.reason.empty())
    set(env, value, "reason", result.reason);
  if (result.kind == "ready") {
    set(env, value, "version", result.version);
    napi_value protocol;
    napi_create_uint32(env, 1, &protocol);
    napi_set_named_property(env, value, "protocol", protocol);
  }
  napi_resolve_deferred(env, deferred, value);
}

std::atomic<bool> start_pending = false, status_pending = false,
                  launch_pending = false, close_pending = false,
                  listen_pending = false, stop_pending = false,
                  call_pending = false;

std::atomic<bool> &busy_flag(const std::string &name) {
  if (name == "start")
    return start_pending;
  if (name == "status")
    return status_pending;
  if (name == "launchStableHost")
    return launch_pending;
  if (name == "close")
    return close_pending;
  if (name == "listenWindows")
    return listen_pending;
  if (name == "stopWindows")
    return stop_pending;
  return call_pending;
}

struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string name, window, payload;
  uint64_t generation = 0;
  uint32_t operation = 0;
  Result result;
  Deadline deadline;
  bool counted = false;
};

bool counted_operation(const std::string &name) {
  return name != "close" && name != "stopWindows";
}

Result stop_windows(Deadline deadline) {
  {
    std::lock_guard guard(server->lock);
    server->windows_enabled = false;
    for (const auto &[id, pending] : server->pending) {
      (void)id;
      pending->changed.notify_all();
    }
  }
  return release_server(server, deadline);
}

void execute(napi_env, void *data) {
  auto &job = *static_cast<Job *>(data);
  try {
    if (job.name == "start")
      job.result = start_status();
    else if (job.name == "status")
      job.result = query_status(job.deadline);
    else if (job.name == "launchStableHost")
      job.result = launch_stable_host(job.deadline);
    else if (job.name == "close")
      job.result = close_status(job.deadline);
    else if (job.name == "listenWindows")
      job.result = ensure_server(server);
    else if (job.name == "stopWindows")
      job.result = stop_windows(job.deadline);
    else
      job.payload =
          call_window(job.operation, job.window, job.generation, job.deadline);
  } catch (...) {
    job.result = {job.name == "close" || job.name == "stopWindows" ? "failed"
                                                                   : "refused",
                  "native-unavailable",
                  {}};
  }
  if (job.counted) {
    job.counted = false;
    --operations;
  }
}

void complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Job> job(static_cast<Job *>(data));
  if (job->counted)
    --operations;
  if (job->name == "stopWindows") {
    std::lock_guard guard(server->lock);
    if (server->callback) {
      napi_release_threadsafe_function(server->callback, napi_tsfn_abort);
      server->callback = nullptr;
    }
  }
  if (status == napi_ok && !job->payload.empty()) {
    napi_value global, json, parse, input, value;
    napi_get_global(env, &global);
    napi_get_named_property(env, global, "JSON", &json);
    napi_get_named_property(env, json, "parse", &parse);
    napi_create_string_utf8(env, job->payload.c_str(), job->payload.size(),
                            &input);
    if (napi_call_function(env, json, parse, 1, &input, &value) == napi_ok)
      napi_resolve_deferred(env, job->deferred, value);
    else {
      bool pending = false;
      napi_is_exception_pending(env, &pending);
      if (pending) {
        napi_value error;
        napi_get_and_clear_last_exception(env, &error);
      }
      resolve_result(env, job->deferred, {"refused", "invalid-receipt", {}});
    }
  } else
    resolve_result(env, job->deferred, job->result);
  napi_delete_async_work(env, job->work);
  busy_flag(job->name) = false;
}

bool window_string(napi_env env, napi_value value, std::string &result,
                   size_t cap) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > cap)
    return false;
  result.resize(length + 1);
  if (napi_get_value_string_utf8(env, value, result.data(), result.size(),
                                 &length) != napi_ok)
    return false;
  result.resize(length);
  return result.find('\0') == std::string::npos;
}

void window_callback(napi_env env, napi_value callback, void *, void *data) {
  std::unique_ptr<Notice> notice(static_cast<Notice *>(data));
  if (!env || !callback)
    return;
  napi_value event, request, number, ignored, global;
  napi_create_object(env, &event);
  set(env, event, "kind", notice->exited ? "peer-exited" : "request");
  if (notice->exited)
    set(env, event, "peer", notice->peer);
  else {
    napi_create_object(env, &request);
    set(env, request, "peer", notice->peer);
    set(env, request, "windowId", notice->window);
    set(env, request, "operation", notice->operation);
    napi_create_double(env, static_cast<double>(notice->request), &number);
    napi_set_named_property(env, request, "requestId", number);
    napi_create_double(env, static_cast<double>(notice->generation), &number);
    napi_set_named_property(env, request, "generation", number);
    napi_get_boolean(env, notice->native_main, &number);
    napi_set_named_property(env, request, "nativeMain", number);
    napi_set_named_property(env, event, "request", request);
  }
  napi_get_global(env, &global);
  napi_call_function(env, global, callback, 1, &event, &ignored);
}

napi_value refuse_now(napi_env env, napi_deferred deferred,
                      napi_value promise) {
  resolve_result(env, deferred, {"refused", "native-unavailable", {}});
  return promise;
}

napi_value operation(napi_env env, napi_callback_info info) {
  napi_value args[3];
  size_t argc = 3;
  void *raw = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, &raw);
  const std::string name = static_cast<const char *>(raw);
  auto job = std::make_unique<Job>();
  job->name = name;
  job->deadline = Clock::now() + operation_bound;
  napi_value promise;
  napi_create_promise(env, &job->deferred, &promise);
  bool valid = main_thread();
  if (name == "listenWindows") {
    napi_valuetype type;
    valid = valid && argc == 1 && napi_typeof(env, args[0], &type) == napi_ok &&
            type == napi_function;
  } else if (name == "openWindow" || name == "renewWindow" ||
             name == "revokeWindow") {
    double generation = 0;
    valid = valid && argc == 2 &&
            window_string(env, args[0], job->window, 36) &&
            job->window.size() == 36 &&
            napi_get_value_double(env, args[1], &generation) == napi_ok &&
            generation >= 1 && generation <= 9007199254740991.0 &&
            std::floor(generation) == generation;
    if (valid)
      job->generation = static_cast<uint64_t>(generation);
    job->operation = name == "openWindow"    ? policy::operation_register
                     : name == "renewWindow" ? policy::operation_renew
                                             : policy::operation_revoke;
  } else
    valid = valid && argc == 0;
  std::atomic<bool> &busy = busy_flag(name);
  if (!valid || busy.exchange(true))
    return refuse_now(env, job->deferred, promise);
  if (name == "listenWindows") {
    napi_value resource;
    napi_create_string_utf8(env, "desktop-client-windows", NAPI_AUTO_LENGTH,
                            &resource);
    std::lock_guard guard(server->lock);
    if (server->callback || server->stopping ||
        napi_create_threadsafe_function(env, args[0], nullptr, resource, 32, 1,
                                        nullptr, nullptr, nullptr,
                                        window_callback,
                                        &server->callback) != napi_ok) {
      busy = false;
      return refuse_now(env, job->deferred, promise);
    }
    napi_unref_threadsafe_function(env, server->callback);
    server->windows_enabled = true;
  }
  if (counted_operation(name)) {
    job->counted = true;
    ++operations;
  }
  napi_value resource;
  napi_create_string_utf8(env, "desktop-peer-linux", NAPI_AUTO_LENGTH,
                          &resource);
  if (napi_create_async_work(env, nullptr, resource, execute, complete,
                             job.get(), &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    busy = false;
    if (job->counted)
      --operations;
    if (job->work)
      napi_delete_async_work(env, job->work);
    return refuse_now(env, job->deferred, promise);
  }
  job.release();
  return promise;
}

napi_value reply_window(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t argc = 3;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool accepted = false;
  double id = 0;
  if (main_thread() && argc == 2 &&
      napi_get_value_double(env, args[0], &id) == napi_ok && id >= 1 &&
      id <= 9007199254740991.0 && std::floor(id) == id) {
    napi_value global, json, stringify, encoded;
    std::string payload;
    napi_get_global(env, &global);
    napi_get_named_property(env, global, "JSON", &json);
    napi_get_named_property(env, json, "stringify", &stringify);
    if (napi_call_function(env, json, stringify, 1, &args[1], &encoded) ==
            napi_ok &&
        window_string(env, encoded, payload, 4095)) {
      std::lock_guard guard(server->lock);
      const auto found = server->pending.find(static_cast<uint64_t>(id));
      if (!server->stopping && found != server->pending.end() &&
          !expired(found->second->deadline)) {
        std::lock_guard pending_guard(found->second->lock);
        if (!found->second->answered) {
          found->second->payload = payload;
          found->second->answered = true;
          found->second->changed.notify_all();
          accepted = true;
        }
      }
    }
  }
  bool pending_exception = false;
  napi_is_exception_pending(env, &pending_exception);
  if (pending_exception) {
    napi_value error;
    napi_get_and_clear_last_exception(env, &error);
  }
  napi_get_boolean(env, accepted, &result);
  return result;
}

// One endpoint per process, named by desktop main from Octant's host paths.
// A second call must name the same endpoint.
napi_value bind_endpoint(napi_env env, napi_callback_info info) {
  napi_value args[4], result;
  size_t argc = 4;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string socket_path, record, version;
  bool accepted = main_thread() && argc == 3 &&
                  window_string(env, args[0], socket_path, 4095) &&
                  window_string(env, args[1], record, 4095) &&
                  window_string(env, args[2], version, 63) &&
                  policy::endpoint_paths(socket_path, record) &&
                  policy::version_text(version);
  if (accepted) {
    std::lock_guard guard(endpoint.lock);
    if (endpoint.bound)
      accepted = endpoint.socket == socket_path && endpoint.record == record &&
                 endpoint.version == version;
    else {
      endpoint.socket = socket_path;
      endpoint.record = record;
      endpoint.version = version;
      endpoint.bound = true;
    }
  }
  bool pending_exception = false;
  napi_is_exception_pending(env, &pending_exception);
  if (pending_exception) {
    napi_value error;
    napi_get_and_clear_last_exception(env, &error);
  }
  napi_get_boolean(env, accepted, &result);
  return result;
}

napi_value initialize(napi_env env, napi_value exports) {
  for (const char *name :
       {"start", "status", "launchStableHost", "close", "listenWindows",
        "stopWindows", "openWindow", "renewWindow", "revokeWindow"}) {
    napi_value function;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, operation,
                         const_cast<char *>(name), &function);
    napi_set_named_property(env, exports, name, function);
  }
  napi_value function;
  napi_create_function(env, "replyWindow", NAPI_AUTO_LENGTH, reply_window,
                       nullptr, &function);
  napi_set_named_property(env, exports, "replyWindow", function);
  napi_create_function(env, "bindEndpoint", NAPI_AUTO_LENGTH, bind_endpoint,
                       nullptr, &function);
  napi_set_named_property(env, exports, "bindEndpoint", function);
  if (main_thread())
    napi_add_env_cleanup_hook(
        env,
        [](void *) {
          {
            std::lock_guard guard(server->lock);
            server->stopping = true;
            server->status_enabled = false;
            server->windows_enabled = false;
            for (const auto &[id, pending] : server->pending) {
              (void)id;
              pending->changed.notify_all();
            }
            if (server->callback) {
              napi_release_threadsafe_function(server->callback,
                                               napi_tsfn_abort);
              server->callback = nullptr;
            }
          }
          if (server->worker.joinable()) {
            if (server->finished)
              server->worker.join();
            else
              server->worker.detach();
          }
        },
        nullptr);
  return exports;
}
#endif
} // namespace
#ifndef OCTANT_PEER_LINUX_TEST
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
#endif
