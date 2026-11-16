/* Kernel-owned launchd scopes retain descendants across fork, setsid and
 * POSIX_SPAWN_SETSID. The private control connection transfers only stdio;
 * its close revokes the scope, including after the launching host dies. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/event.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <util.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
#ifdef OCTANT_SCOPE_TRACE
#define TRACE(message) dprintf(2, "octant-sandbox-scope: %s\n", message)
#else
#define TRACE(message) ((void)0)
#endif
#define MAX_VECTOR 16384u
#define MAX_WIRE (8u * 1024u * 1024u)
#define RECEIPT_MAGIC UINT64_C(0x4f435453434f5031)
struct coalitions { uint64_t resource, jetsam, reserved[3]; };
struct unique_identity {
  unsigned char uuid[16];
  uint64_t unique, parent;
  int32_t version, parent_version;
  uint64_t reserved[2];
};
struct receipt {
  uint64_t magic, coalition, owner_unique;
  int32_t owner, client;
  uint64_t client_unique;
  char boot[64], epoch[128], label[160];
};
static int full_write(int fd, const void *bytes, size_t size) {
  const char *p = bytes;
  while (size) {
    ssize_t n = write(fd, p, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    p += n; size -= (size_t)n;
  }
  return 0;
}
static int full_read(int fd, void *bytes, size_t size) {
  char *p = bytes;
  while (size) {
    ssize_t n = read(fd, p, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    p += n; size -= (size_t)n;
  }
  return 0;
}
static uint64_t coalition(pid_t pid) {
  struct coalitions c = {0};
  return proc_pidinfo(pid, 20, 0, &c, sizeof(c)) == (int)sizeof(c) ? c.resource : 0;
}
static uint64_t unique(pid_t pid) {
  struct unique_identity u = {0};
  return proc_pidinfo(pid, 17, 0, &u, sizeof(u)) == (int)sizeof(u) ? u.unique : 0;
}
static int boot_id(char out[64]) {
  size_t size = 64;
  memset(out, 0, 64);
  return sysctlbyname("kern.bootsessionuuid", out, &size, NULL, 0);
}
static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static int token(const char *s) {
  if (!*s || strlen(s) >= 128) return 0;
  for (; *s; ++s)
    if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') ||
          (*s >= '0' && *s <= '9') || strchr("-_:.", *s))) return 0;
  return 1;
}
static int private_directory(const char *path) {
  char resolved[PATH_MAX];
  if (!realpath(path, resolved) || strcmp(resolved, path)) return -1;
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (fd < 0) return -1;
  if (fstat(fd, &st) || st.st_uid != getuid() || (st.st_mode & 077)) {
    close(fd); return -1;
  }
  return fd;
}
/* Freeze the complete kernel scope before killing it. Repeated census finds
 * children created during the first pass; stopped processes cannot fork. */
static int revoke_scope(uint64_t scope, pid_t except) {
  if (!scope || (scope == coalition(getpid()) && except != getpid())) return -1;
  double deadline = now() + 5;
  unsigned quiet = 0;
  int killing = 0;
  while (now() < deadline) {
    int count = proc_listallpids(NULL, 0);
    if (count <= 0 || count > 1000000) return -1;
    size_t capacity = (size_t)count + 256;
    pid_t *pids = calloc(capacity, sizeof(pid_t));
    if (!pids) return -1;
    count = proc_listallpids(pids, (int)(capacity * sizeof(pid_t)));
    if (count < 0 || (size_t)count >= capacity) { free(pids); continue; }
    unsigned living = 0, moving = 0;
    for (int i = 0; i < count; ++i) {
      pid_t pid = pids[i];
      if (pid <= 1 || pid == except || coalition(pid) != scope) continue;
      struct proc_bsdinfo bsd = {0};
      if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != (int)sizeof(bsd)) continue;
      if (bsd.pbi_status == 5) continue; /* SZOMB has no runnable authority. */
      ++living;
      if (bsd.pbi_status != 4) ++moving; /* SSTOP */
      if (coalition(pid) == scope && kill(pid, killing ? SIGKILL : SIGSTOP) && errno != ESRCH) {
        free(pids); return -1;
      }
    }
    free(pids);
    if (!living) return 0;
    if (!killing) {
      quiet = moving ? 0 : quiet + 1;
      if (quiet >= 2) killing = 1;
    }
    usleep(10000);
  }
  return -1;
}
static int exclusive_scope(uint64_t scope, pid_t service) {
  int count = proc_listallpids(NULL, 0);
  if (!scope || count <= 0 || count > 1000000) return 0;
  size_t capacity = (size_t)count + 256;
  pid_t *pids = calloc(capacity, sizeof(pid_t));
  if (!pids) return 0;
  count = proc_listallpids(pids, (int)(capacity * sizeof(pid_t)));
  int exclusive = count > 0 && (size_t)count < capacity;
  for (int i = 0; i < count && exclusive; ++i)
    if (pids[i] > 0 && pids[i] != service && coalition(pids[i]) == scope) exclusive = 0;
  free(pids);
  return exclusive;
}
static int send_vector(int fd, char *const *values) {
  uint32_t count = 0, total = 0;
  while (values[count]) if (++count >= MAX_VECTOR) return -1;
  if (full_write(fd, &count, sizeof(count))) return -1;
  for (uint32_t i = 0; i < count; ++i) {
    size_t size = strlen(values[i]) + 1;
    if (size > MAX_WIRE || total > MAX_WIRE - size) return -1;
    total += (uint32_t)size;
    uint32_t n = (uint32_t)size;
    if (full_write(fd, &n, sizeof(n)) || full_write(fd, values[i], n)) return -1;
  }
  return 0;
}
static char **read_vector(int fd) {
  uint32_t count, total = 0;
  if (full_read(fd, &count, sizeof(count)) || count >= MAX_VECTOR) return NULL;
  char **values = calloc((size_t)count + 1, sizeof(char *));
  if (!values) return NULL;
  for (uint32_t i = 0; i < count; ++i) {
    uint32_t size;
    if (full_read(fd, &size, sizeof(size)) || !size || size > MAX_WIRE || total > MAX_WIRE - size) return NULL;
    total += size;
    values[i] = malloc(size);
    if (!values[i] || full_read(fd, values[i], size) || values[i][size-1] || strlen(values[i]) != size-1) return NULL;
  }
  return values;
}
static int transfer_fds(int fd, int receive, int *fds, unsigned count) {
  if (!count || count > 3) return -1;
  char byte = 1, control[CMSG_SPACE(sizeof(int) * 3)] = {0};
  struct iovec io = { &byte, 1 };
  struct msghdr msg = {0};
  msg.msg_iov = &io; msg.msg_iovlen = 1;
  msg.msg_control = control; msg.msg_controllen = CMSG_SPACE(sizeof(int) * count);
  if (receive) {
    if (recvmsg(fd, &msg, 0) != 1 || (msg.msg_flags & (MSG_CTRUNC | MSG_TRUNC))) return -1;
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    if (!c || c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(sizeof(int)*count)) return -1;
    memcpy(fds, CMSG_DATA(c), sizeof(int)*count);
  } else {
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int)*count);
    memcpy(CMSG_DATA(c), fds, sizeof(int)*count);
    if (sendmsg(fd, &msg, 0) != 1) return -1;
  }
  return 0;
}
static int socket_address(struct sockaddr_un *address, const char *path) {
  memset(address, 0, sizeof(*address));
  if (strlen(path) >= sizeof(address->sun_path)) return -1;
  address->sun_family = AF_UNIX;
  strlcpy(address->sun_path, path, sizeof(address->sun_path));
  return 0;
}
static int peer_pid(int fd, pid_t *pid) {
  socklen_t n = sizeof(*pid);
  uid_t uid; gid_t gid;
  return getpeereid(fd, &uid, &gid) || uid != getuid() ||
         getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, &n) || n != sizeof(*pid);
}
static int serve(const char *path) {
  struct sockaddr_un address;
  if (socket_address(&address, path)) return 125;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) return 125;
  pid_t client;
  if (peer_pid(fd, &client)) return 125;
  int stdio[3];
  if (transfer_fds(fd, 1, stdio, 3)) return 125;
  char **cwd = read_vector(fd), **args = read_vector(fd), **environment = read_vector(fd);
  if (!cwd || !cwd[0] || cwd[1] || cwd[0][0] != '/' || chdir(cwd[0]) || !args || !args[0] || strcmp(args[0], "/usr/bin/sandbox-exec") || !environment) return 125;
  uint32_t terminal = isatty(stdio[0]) ? 1 : 0;
  int master = -1, slave = -1;
  if (terminal) {
    struct winsize size = {0};
    if (ioctl(stdio[0], TIOCGWINSZ, &size) || openpty(&master, &slave, NULL, NULL, &size)) return 125;
  }
  if (full_write(fd, &terminal, sizeof(terminal)) ||
      (terminal && transfer_fds(fd, 0, &master, 1))) return 125;
  /* The owner has already fsynced its receipt before sending the vectors. */
  pid_t child = fork();
  if (child < 0) return 125;
  if (!child) {
    for (int i = 0; i < 3; ++i) if (dup2(terminal ? slave : stdio[i], i) < 0) _exit(125);
    TRACE("payload descriptors");
    if (isatty(0)) {
      TRACE("payload terminal");
      if (setsid() < 0 || ioctl(0, TIOCSCTTY, 0) < 0) _exit(125);
      signal(SIGTTOU, SIG_IGN);
      if (tcsetpgrp(0, getpgrp())) _exit(125);
      signal(SIGTTOU, SIG_DFL);
    }
    TRACE("payload execute");
    int maximum_fd = getdtablesize();
    if (maximum_fd < 3) _exit(125);
    for (int fd = 3; fd < maximum_fd; ++fd) close(fd);
    execve(args[0], args, environment);
    _exit(125);
  }
  for (int i = 0; i < 3; ++i) close(stdio[i]);
  if (master >= 0) close(master);
  if (slave >= 0) close(slave);
  int status = 125 << 8;
  for (;;) {
    if (waitpid(child, &status, WNOHANG) == child) break;
    struct pollfd pollfd = {fd, POLLIN | POLLHUP, 0};
    if (poll(&pollfd, 1, 50) < 0 && errno != EINTR) break;
    if (pollfd.revents) break;
  }
  if (revoke_scope(coalition(getpid()), getpid())) return 125;
  int result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  (void)full_write(fd, &result, sizeof(result));
  close(fd);
  return 0;
}
static int launchctl(char *const args[]) {
  pid_t pid;
  char *clean[] = {"PATH=/usr/bin:/bin", NULL};
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  if (posix_spawn_file_actions_init(&actions)) return -1;
  if (posix_spawnattr_init(&attributes)) { posix_spawn_file_actions_destroy(&actions); return -1; }
  int error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  for (int i = 0; i < 3 && !error; ++i)
    error = posix_spawn_file_actions_addopen(&actions, i, "/dev/null", O_RDWR, 0);
  if (!error) error = posix_spawn(&pid, "/bin/launchctl", &actions, &attributes, args, clean);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  if (error) return -1;
  int status;
  double deadline = now() + 5;
  for (;;) {
    pid_t waited = waitpid(pid, &status, WNOHANG);
    if (waited == pid) break;
    if (waited < 0 && errno != EINTR) return -1;
    if (now() > deadline) {
      kill(pid, SIGKILL);
      while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
      return -1;
    }
    usleep(10000);
  }
  return WIFEXITED(status) && !WEXITSTATUS(status) ? 0 : -1;
}
static int remove_control(const char *label) {
  static const char prefix[] = "app.octant.sandbox.";
  if (strncmp(label, prefix, sizeof(prefix)-1)) return -1;
  const char *name = label + sizeof(prefix)-1;
  if (strncmp(name, "octant-sandbox-control-", sizeof("octant-sandbox-control-")-1) || !token(name)) return -1;
  char path[PATH_MAX], canonical[PATH_MAX];
  snprintf(path, sizeof(path), "/tmp/%s", name);
  if (!realpath(path, canonical)) return errno == ENOENT ? 0 : -1;
  int directory = private_directory(canonical);
  if (directory < 0) return errno == ENOENT ? 0 : -1;
  int error = 0;
  if (unlinkat(directory, "control.sock", 0) && errno != ENOENT) error = -1;
  if (unlinkat(directory, "job.plist", 0) && errno != ENOENT) error = -1;
  close(directory);
  if (rmdir(canonical) && errno != ENOENT) error = -1;
  return error;
}
static void xml(FILE *file, const char *s) {
  for (; *s; ++s) {
    switch (*s) {
      case '&': fputs("&amp;", file); break;
      case '<': fputs("&lt;", file); break;
      case '>': fputs("&gt;", file); break;
      case '\"': fputs("&quot;", file); break;
      default: fputc(*s, file);
    }
  }
}
/* Keep the caller's terminal session intact. The payload owns a separate
 * PTY inside the kernel scope; bytes, window size and terminal-generated
 * signals cross this bridge without exposing the private control descriptor. */
static int terminal_bridge(int control, int master, pid_t owner, int *result) {
  struct termios saved, raw;
  if (tcgetattr(0, &saved)) return -1;
  raw = saved; cfmakeraw(&raw);
  int in_flags = fcntl(0, F_GETFL), out_flags = fcntl(1, F_GETFL), master_flags = fcntl(master, F_GETFL);
  if (in_flags < 0 || out_flags < 0 || master_flags < 0) return -1;
  int error = -1;
  if (fcntl(0, F_SETFL, in_flags|O_NONBLOCK) || fcntl(1, F_SETFL, out_flags|O_NONBLOCK) ||
      fcntl(master, F_SETFL, master_flags|O_NONBLOCK) || tcsetattr(0, TCSANOW, &raw)) goto done;
  unsigned char input[65536], output[65536];
  size_t in_size = 0, out_size = 0;
  int input_open = 1, master_open = 1, finished = 0;
  double drain_deadline = 0;
  struct winsize previous = {0};
  for (;;) {
    if (getppid() != owner) break;
    if (finished && ((!master_open && !out_size) || now() > drain_deadline)) { error = 0; break; }
    struct winsize size;
    if (!ioctl(0, TIOCGWINSZ, &size) && memcmp(&size, &previous, sizeof(size))) {
      if (ioctl(master, TIOCSWINSZ, &size)) break;
      previous = size;
    }
    struct pollfd fds[] = {
      {finished ? -1 : control, POLLIN|POLLHUP, 0},
      {input_open && in_size < sizeof(input) ? 0 : -1, POLLIN, 0},
      {master, (short)((master_open && out_size < sizeof(output) ? POLLIN : 0) | (in_size ? POLLOUT : 0)), 0},
      {out_size ? 1 : -1, POLLOUT, 0},
    };
    if (poll(fds, 4, 50) < 0) { if (errno == EINTR) continue; break; }
    if (fds[0].revents) {
      if (full_read(control, result, sizeof(*result))) break;
      finished = 1; drain_deadline = now() + 2;
    }
    if (fds[1].revents & (POLLIN|POLLHUP)) {
      ssize_t n = read(0, input+in_size, sizeof(input)-in_size);
      if (n > 0) in_size += (size_t)n;
      else if (!n) input_open = 0;
      else if (errno != EAGAIN && errno != EINTR) break;
    }
    if (fds[2].revents & (POLLIN|POLLHUP)) {
      ssize_t n = read(master, output+out_size, sizeof(output)-out_size);
      if (n > 0) out_size += (size_t)n;
      else if (!n || errno == EIO) master_open = 0;
      else if (errno != EAGAIN && errno != EINTR) break;
    }
    if (in_size && (fds[2].revents & POLLOUT)) {
      ssize_t n = write(master, input, in_size);
      if (n > 0) { in_size -= (size_t)n; memmove(input, input+n, in_size); }
      else if (n < 0 && errno != EAGAIN && errno != EINTR) break;
    }
    if (out_size && (fds[3].revents & POLLOUT)) {
      ssize_t n = write(1, output, out_size);
      if (n > 0) { out_size -= (size_t)n; memmove(output, output+n, out_size); }
      else if (n < 0 && errno != EAGAIN && errno != EINTR) break;
    }
  }
done:
  (void)tcsetattr(0, TCSANOW, &saved);
  (void)fcntl(0, F_SETFL, in_flags); (void)fcntl(1, F_SETFL, out_flags);
  close(master);
  return error;
}
static int run(const char *root, const char *epoch, char **args) {
  if (!token(epoch) || strcmp(args[0], "/usr/bin/sandbox-exec")) return 125;
  int directory = private_directory(root);
  if (directory < 0) return 125;
  char control[] = "/tmp/octant-sandbox-control-XXXXXXXX";
  if (!mkdtemp(control) || chmod(control, 0700)) return 125;
  char socket_path[PATH_MAX], plist[PATH_MAX], executable[PATH_MAX], label[160], domain[64], service[256], receipt_name[128];
  snprintf(socket_path, sizeof(socket_path), "%s/control.sock", control);
  snprintf(plist, sizeof(plist), "%s/job.plist", control);
  snprintf(label, sizeof(label), "app.octant.sandbox.%s", strrchr(control, '/')+1);
  snprintf(domain, sizeof(domain), "gui/%u", getuid());
  snprintf(service, sizeof(service), "%s/%s", domain, label);
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size)) return 125;
  char resolved[PATH_MAX];
  if (!realpath(executable, resolved)) return 125;
  struct sockaddr_un address;
  if (socket_address(&address, socket_path)) return 125;
  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 1)) return 125;
  FILE *file = fopen(plist, "wx");
  if (!file) return 125;
  fputs("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>", file); xml(file, label);
  fputs("</string><key>ProgramArguments</key><array><string>", file); xml(file, resolved);
  fputs("</string><string>--service</string><string>", file); xml(file, socket_path);
  fputs("</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>", file);
  fclose(file);
  char *bootstrap[] = {"launchctl", "bootstrap", domain, plist, NULL};
  TRACE("bootstrap");
  int registered = launchctl(bootstrap) == 0, result = 125, control_fd = -1, receipt_written = 0;
  struct receipt record = {0};
  if (!registered) goto cleanup;
  struct pollfd wait = {listener, POLLIN, 0};
  if (poll(&wait, 1, 10000) <= 0) goto cleanup;
  TRACE("accept");
  control_fd = accept(listener, NULL, NULL);
  pid_t service_pid;
  if (control_fd < 0 || peer_pid(control_fd, &service_pid)) goto cleanup;
  record.magic = RECEIPT_MAGIC;
  uint64_t candidate_scope = coalition(service_pid);
  if (!candidate_scope || candidate_scope == coalition(getpid()) || !exclusive_scope(candidate_scope, service_pid)) goto cleanup;
  record.coalition = candidate_scope;
  record.owner = getppid(); record.owner_unique = unique(record.owner);
  strlcpy(record.epoch, epoch, sizeof(record.epoch));
  strlcpy(record.label, label, sizeof(record.label));
  record.client = getpid(); record.client_unique = unique(getpid());
  if (!record.coalition || record.coalition == coalition(getpid()) || !record.owner_unique || boot_id(record.boot)) goto cleanup;
  snprintf(receipt_name, sizeof(receipt_name), "%d-%" PRIu64 ".scope", getpid(), unique(getpid()));
  char pending_name[160];
  snprintf(pending_name, sizeof(pending_name), "%s.pending", receipt_name);
  int receipt_fd = openat(directory, pending_name, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600);
  if (receipt_fd < 0) goto cleanup;
  int receipt_error = full_write(receipt_fd, &record, sizeof(record)) || fsync(receipt_fd);
  close(receipt_fd);
  if (receipt_error || renameat(directory, pending_name, directory, receipt_name) || fsync(directory)) {
    unlinkat(directory, pending_name, 0);
    goto cleanup;
  }
  receipt_written = 1;
  TRACE("receipt ready");
  int stdio[] = {0,1,2};
  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof(cwd))) goto cleanup;
  char *cwd_vector[] = {cwd, NULL};
  if (transfer_fds(control_fd, 0, stdio, 3) || send_vector(control_fd, cwd_vector) || send_vector(control_fd, args) || send_vector(control_fd, environ)) goto cleanup;
  uint32_t terminal;
  if (full_read(control_fd, &terminal, sizeof(terminal)) || terminal > 1) goto cleanup;
  if (terminal) {
    int master;
    if (transfer_fds(control_fd, 1, &master, 1) || terminal_bridge(control_fd, master, record.owner, &result)) result = 125;
    goto cleanup;
  }
  TRACE("workload released");
  for (;;) {
    if (getppid() != record.owner) goto cleanup;
    struct pollfd wait = {control_fd, POLLIN | POLLHUP, 0};
    int n = poll(&wait, 1, 50);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) goto cleanup;
    if (wait.revents) {
      if (full_read(control_fd, &result, sizeof(result))) result = 125;
      break;
    }
  }
cleanup:
  TRACE("cleanup");
  if (control_fd >= 0) close(control_fd);
  int revoked = !record.coalition || !revoke_scope(record.coalition, 0);
  TRACE(revoked ? "scope revoked" : "scope revocation failed");
  if (!revoked) result = 125;
  if (registered) {
    char *bootout[] = {"launchctl", "bootout", service, NULL};
    if (launchctl(bootout)) result = 125;
    TRACE("job unload finished");
  }
  close(listener);
  if (remove_control(label)) { result = 125; revoked = 0; }
  if (receipt_written && revoked) { unlinkat(directory, receipt_name, 0); fsync(directory); }
  close(directory);
  TRACE("client complete");
  return result;
}
static int reap(const char *root, const char *epoch, pid_t client) {
  int directory = private_directory(root), result = 0;
  if (directory < 0 || (strcmp(epoch, "--stale") && !token(epoch))) return 125;
  DIR *entries = fdopendir(dup(directory));
  if (!entries) return 125;
  struct dirent *entry; unsigned count = 0;
  char boot[64];
  if (boot_id(boot)) return 125;
  while ((entry = readdir(entries))) {
    size_t n = strlen(entry->d_name);
    if (n > 14 && !strcmp(entry->d_name+n-14, ".scope.pending")) {
      int pending_client; uint64_t identity;
      char expected[160];
      if (sscanf(entry->d_name, "%d-%" SCNu64, &pending_client, &identity) != 2 || pending_client <= 1 || !identity) { result = 125; continue; }
      snprintf(expected, sizeof(expected), "%d-%" PRIu64 ".scope.pending", pending_client, identity);
      if (strcmp(expected, entry->d_name)) { result = 125; continue; }
      if (unique(pending_client) == identity) continue;
      struct stat pending_stat;
      if (fstatat(directory, entry->d_name, &pending_stat, AT_SYMLINK_NOFOLLOW)) { if (errno != ENOENT) result = 125; continue; }
      if (!S_ISREG(pending_stat.st_mode) || pending_stat.st_uid != getuid() || (pending_stat.st_mode & 077) || pending_stat.st_nlink != 1) { result = 125; continue; }
      if (unlinkat(directory, entry->d_name, 0) && errno != ENOENT) result = 125;
      continue;
    }
    if (n < 6 || strcmp(entry->d_name+n-6, ".scope")) continue;
    if (++count > 4096) { result = 125; break; }
    int fd = openat(directory, entry->d_name, O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    struct stat st;
    struct receipt record;
    if (fd < 0) { if (errno != ENOENT) result = 125; continue; }
    int error = fstat(fd, &st) || st.st_uid != getuid() || (st.st_mode & 077) ||
      st.st_size != sizeof(record) || full_read(fd, &record, sizeof(record));
    close(fd);
    if (error || record.magic != RECEIPT_MAGIC || !memchr(record.epoch, 0, sizeof(record.epoch)) ||
        !memchr(record.boot, 0, sizeof(record.boot)) || !memchr(record.label, 0, sizeof(record.label)) ||
        strncmp(record.label, "app.octant.sandbox.octant-sandbox-control-", sizeof("app.octant.sandbox.octant-sandbox-control-")-1) ||
        !token(record.label) || !token(record.epoch)) { fputs("octant-sandbox-scope: invalid ownership receipt\n", stderr); result = 125; continue; }
    if (client > 0 && record.client != client) continue;
    if (!strcmp(epoch, "--stale")) {
      if (record.owner > 1 && unique(record.owner) == record.owner_unique) continue;
    } else if (strcmp(record.epoch, epoch)) continue;
    if (!strcmp(boot, record.boot) && revoke_scope(record.coalition, 0)) { fputs("octant-sandbox-scope: kernel scope revocation failed\n", stderr); result = 125; continue; }
    if (!strcmp(boot, record.boot)) {
      char service[256];
      snprintf(service, sizeof(service), "gui/%u/%s", getuid(), record.label);
      char *bootout[] = {"launchctl", "bootout", service, NULL};
      /* An already unloaded owned job is also a completed revocation. */
      (void)launchctl(bootout);
    }
    if (!strcmp(boot, record.boot) && remove_control(record.label)) { result = 125; continue; }
    if (unlinkat(directory, entry->d_name, 0) && errno != ENOENT) result = 125;
  }
  closedir(entries); fsync(directory); close(directory);
  return result;
}
int main(int argc, char **argv) {
  if (getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) return 125;
  signal(SIGPIPE, SIG_IGN);
  umask(0077);
  if (argc == 2 && !strcmp(argv[1], "--check")) {
    char boot[64], domain[64];
    if (!coalition(getpid()) || !unique(getpid()) || boot_id(boot)) return 125;
    snprintf(domain, sizeof(domain), "gui/%u", getuid());
    char *args[] = {"launchctl", "print", domain, NULL};
    return launchctl(args) ? 125 : 0;
  }
  if (argc == 3 && !strcmp(argv[1], "--service")) return serve(argv[2]);
  if (argc == 4 && !strcmp(argv[1], "--reap")) return reap(argv[2], argv[3], 0);
  if (argc == 5 && !strcmp(argv[1], "--reap-owner")) {
    char *end; long pid = strtol(argv[4], &end, 10);
    if (*end || pid <= 1 || pid > INT_MAX) return 125;
    return reap(argv[2], argv[3], (pid_t)pid);
  }
  if (argc >= 6 && !strcmp(argv[1], "--run") && !strcmp(argv[4], "--")) return run(argv[2], argv[3], argv+5);
  return 125;
}
