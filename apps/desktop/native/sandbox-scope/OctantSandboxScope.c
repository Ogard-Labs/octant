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
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
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
static int transfer_fds(int fd, int receive, int fds[3]) {
  char byte = 1, control[CMSG_SPACE(sizeof(int) * 3)] = {0};
  struct iovec io = { &byte, 1 };
  struct msghdr msg = {0};
  msg.msg_iov = &io; msg.msg_iovlen = 1;
  msg.msg_control = control; msg.msg_controllen = sizeof(control);
  if (receive) {
    if (recvmsg(fd, &msg, 0) != 1 || (msg.msg_flags & (MSG_CTRUNC | MSG_TRUNC))) return -1;
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    if (!c || c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(sizeof(int)*3)) return -1;
    memcpy(fds, CMSG_DATA(c), sizeof(int)*3);
  } else {
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int)*3);
    memcpy(CMSG_DATA(c), fds, sizeof(int)*3);
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
  if (transfer_fds(fd, 1, stdio)) return 125;
  char **cwd = read_vector(fd), **args = read_vector(fd), **environment = read_vector(fd);
  if (!cwd || !cwd[0] || cwd[1] || cwd[0][0] != '/' || chdir(cwd[0]) || !args || !args[0] || strcmp(args[0], "/usr/bin/sandbox-exec") || !environment) return 125;
  /* The owner has already fsynced its receipt before sending the vectors. */
  pid_t child = fork();
  if (child < 0) return 125;
  if (!child) {
    for (int i = 0; i < 3; ++i) if (dup2(stdio[i], i) < 0) _exit(125);
    int maximum_fd = getdtablesize();
    if (maximum_fd < 3) _exit(125);
    for (int fd = 3; fd < maximum_fd; ++fd) close(fd);
    execve(args[0], args, environment);
    _exit(125);
  }
  for (int i = 0; i < 3; ++i) close(stdio[i]);
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
  int error = posix_spawn(&pid, "/bin/launchctl", NULL, NULL, args, clean);
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
  int registered = launchctl(bootstrap) == 0, result = 125, control_fd = -1, receipt_written = 0;
  struct receipt record = {0};
  if (!registered) goto cleanup;
  struct pollfd wait = {listener, POLLIN, 0};
  if (poll(&wait, 1, 10000) <= 0) goto cleanup;
  control_fd = accept(listener, NULL, NULL);
  pid_t service_pid;
  if (control_fd < 0 || peer_pid(control_fd, &service_pid)) goto cleanup;
  record.magic = RECEIPT_MAGIC;
  record.coalition = coalition(service_pid);
  record.owner = getppid(); record.owner_unique = unique(record.owner);
  strlcpy(record.epoch, epoch, sizeof(record.epoch));
  strlcpy(record.label, label, sizeof(record.label));
  record.client = getpid(); record.client_unique = unique(getpid());
  if (!record.coalition || record.coalition == coalition(getpid()) || !record.owner_unique || boot_id(record.boot)) goto cleanup;
  snprintf(receipt_name, sizeof(receipt_name), "%d-%" PRIu64 ".scope", getpid(), unique(getpid()));
  int receipt_fd = openat(directory, receipt_name, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600);
  if (receipt_fd < 0) goto cleanup;
  int receipt_error = full_write(receipt_fd, &record, sizeof(record)) || fsync(receipt_fd);
  close(receipt_fd);
  if (receipt_error || fsync(directory)) goto cleanup;
  receipt_written = 1;
  int stdio[] = {0,1,2};
  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof(cwd))) goto cleanup;
  char *cwd_vector[] = {cwd, NULL};
  if (transfer_fds(control_fd, 0, stdio) || send_vector(control_fd, cwd_vector) || send_vector(control_fd, args) || send_vector(control_fd, environ)) goto cleanup;
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
  if (control_fd >= 0) close(control_fd);
  if (record.coalition && revoke_scope(record.coalition, 0)) result = 125;
  else if (receipt_written) { unlinkat(directory, receipt_name, 0); fsync(directory); }
  if (registered) {
    char *bootout[] = {"launchctl", "bootout", service, NULL};
    if (launchctl(bootout)) result = 125;
  }
  close(listener); close(directory);
  unlink(socket_path); unlink(plist); rmdir(control);
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
    if (n < 6 || strcmp(entry->d_name+n-6, ".scope")) continue;
    if (++count > 4096) { result = 125; break; }
    int fd = openat(directory, entry->d_name, O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    struct stat st;
    struct receipt record;
    if (fd < 0) { result = 125; continue; }
    int error = fstat(fd, &st) || st.st_uid != getuid() || (st.st_mode & 077) ||
      st.st_size != sizeof(record) || full_read(fd, &record, sizeof(record));
    close(fd);
    if (error || record.magic != RECEIPT_MAGIC || !memchr(record.epoch, 0, sizeof(record.epoch)) ||
        !memchr(record.boot, 0, sizeof(record.boot)) || !memchr(record.label, 0, sizeof(record.label)) ||
        strncmp(record.label, "app.octant.sandbox.octant-sandbox-control-", sizeof("app.octant.sandbox.octant-sandbox-control-")-1) ||
        !token(record.label) || !token(record.epoch)) { result = 125; continue; }
    if (client > 0 && record.client != client) continue;
    if (!strcmp(epoch, "--stale")) {
      if (record.owner > 1 && unique(record.owner) == record.owner_unique) continue;
    } else if (strcmp(record.epoch, epoch)) continue;
    if (!strcmp(boot, record.boot) && revoke_scope(record.coalition, 0)) { result = 125; continue; }
    if (!strcmp(boot, record.boot)) {
      char service[256];
      snprintf(service, sizeof(service), "gui/%u/%s", getuid(), record.label);
      char *bootout[] = {"launchctl", "bootout", service, NULL};
      /* An already unloaded owned job is also a completed revocation. */
      (void)launchctl(bootout);
    }
    if (unlinkat(directory, entry->d_name, 0)) result = 125;
  }
  closedir(entries); fsync(directory); close(directory);
  return result;
}
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  umask(0077);
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
