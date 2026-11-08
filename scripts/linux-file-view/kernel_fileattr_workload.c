/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/vfs.h>
#include <time.h>
#include <unistd.h>

#define ROOT "/octant-fileattr"
#define KEY ROOT "/home/.ssh/deployment"
#define BASELINE ROOT "/fileattr-before"
struct baseline { struct stat identity; unsigned int flags; };

static bool same_time(struct timespec left, struct timespec right)
{
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}
static int verify(void)
{
  struct baseline before = {0};
  struct stat after = {0};
  unsigned int flags = 0;
  int saved = open(BASELINE, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool loaded = saved >= 0 && read(saved, &before, sizeof(before)) == sizeof(before);
  if (saved >= 0) close(saved);
  int held = open(KEY, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool measured = loaded && held >= 0 && !fstat(held, &after) &&
    !ioctl(held, FS_IOC_GETFLAGS, &flags);
  bool flags_unchanged = measured && flags == before.flags;
  bool stat_unchanged = measured &&
    after.st_dev == before.identity.st_dev && after.st_ino == before.identity.st_ino &&
    after.st_mode == before.identity.st_mode && after.st_uid == before.identity.st_uid &&
    after.st_gid == before.identity.st_gid && after.st_size == before.identity.st_size &&
    same_time(after.st_atim, before.identity.st_atim) &&
    same_time(after.st_mtim, before.identity.st_mtim) &&
    same_time(after.st_ctim, before.identity.st_ctim);
  if (held >= 0) close(held);
  bool unchanged = flags_unchanged && stat_unchanged;
  printf("OCTANT_FILEATTR_OWNER {\"pid\":%ld,\"parent\":%ld,\"measured\":%s,\"flagsUnchanged\":%s,\"statUnchanged\":%s,\"unchanged\":%s}\n",
    (long)getpid(), (long)getppid(), measured ? "true" : "false", flags_unchanged ? "true" : "false",
    stat_unchanged ? "true" : "false", unchanged ? "true" : "false");
  return unchanged ? 0 : 1;
}
static bool queued_bytes(int pair[2])
{
  if (pair[0] < 0 || pair[1] < 0) return false;
  int available = -1;
  bool allowed = write(pair[1], "ok", 2) == 2 &&
    !ioctl(pair[0], FIONREAD, &available) && available == 2;
  close(pair[0]); close(pair[1]);
  return allowed;
}

int main(int argc, char **argv)
{
  alarm(12);
  if (argc == 2 && !strcmp(argv[1], "--verify-fileattr")) return verify();
  if (argc != 1) return 1;
  for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) return 2;
  struct baseline before = {0};
  struct statfs filesystem;
  char bytes[64];
  int held = open(KEY, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (held < 0 || fstatfs(held, &filesystem) || filesystem.f_type != EXT4_SUPER_MAGIC ||
      pread(held, bytes, sizeof(bytes), 0) <= 0 || fstat(held, &before.identity) ||
      ioctl(held, FS_IOC_GETFLAGS, &before.flags)) return 3;
  int before_available = -1;
  long long before_usage = -1;
  if (ioctl(held, FIONREAD, &before_available) || before_available != before.identity.st_size ||
      ioctl(held, FIOQSIZE, &before_usage) || before_usage < 0) return 7;
  puts("OCTANT_FILEATTR_FILESYSTEM {\"ext4\":true,\"baselineRead\":true}");
  int saved = open(BASELINE, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (saved < 0 || write(saved, &before, sizeof(before)) != sizeof(before) || fsync(saved)) return 4;
  close(saved);
  int stage = open(ROOT "/stage", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (stage < 0) return 5;
  close(stage);
  bool present = false;
  for (unsigned attempt = 0; attempt < 800; attempt++) {
    if (!access(KEY ".pub", F_OK)) { present = true; break; }
    struct timespec pause = {.tv_nsec = 10000000};
    nanosleep(&pause, NULL);
  }
  if (!present) return 6;
  const unsigned int sentinel = 0x5a5a5a5a;
  unsigned int private_output = sentinel;
  errno = 0;
  int observation = ioctl(held, FS_IOC_GETFLAGS, &private_output);
  int read_failure = observation < 0 ? errno : 0;
  bool private_read_refused = observation == -1 && read_failure == EACCES;
  bool private_output_unchanged = private_output == sentinel;
  const int available_sentinel = 0x5a5a5a5a;
  const long long usage_sentinel = 0x5a5a5a5a5a5a5a5aLL;
  int private_available = available_sentinel;
  long long private_usage = usage_sentinel;
  errno = 0;
  int available_result = ioctl(held, FIONREAD, &private_available);
  int available_errno = available_result < 0 ? errno : 0;
  errno = 0;
  int usage_result = ioctl(held, FIOQSIZE, &private_usage);
  int usage_errno = usage_result < 0 ? errno : 0;
  bool available_refused = available_result == -1 && available_errno == EACCES && private_available == available_sentinel;
  bool usage_refused = usage_result == -1 && usage_errno == EACCES && private_usage == usage_sentinel;
  unsigned int changed = before.flags ^ FS_NODUMP_FL;
  errno = 0;
  int mutation = ioctl(held, FS_IOC_SETFLAGS, &changed);
  int failure = mutation < 0 ? errno : 0;
  bool private_refused = mutation == -1 && failure == EACCES;
  close(held);

  int public = open(KEY ".pub", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  unsigned int initial = 0, observed = 0, restored = 0;
  bool public_changed = false, public_restored = false;
  if (public >= 0 && !ioctl(public, FS_IOC_GETFLAGS, &initial)) {
    unsigned int requested = initial ^ FS_NODUMP_FL;
    public_changed = !ioctl(public, FS_IOC_SETFLAGS, &requested) &&
      !ioctl(public, FS_IOC_GETFLAGS, &observed) && observed == requested;
    // Restore even when readback fails; never leave the positive control's flag set.
    public_restored = !ioctl(public, FS_IOC_SETFLAGS, &initial) &&
      !ioctl(public, FS_IOC_GETFLAGS, &restored) && restored == initial;
  }
  int public_available = -1;
  long long public_usage = -1;
  bool public_queries = public >= 0 && !ioctl(public, FIONREAD, &public_available) && public_available >= 0 &&
    !ioctl(public, FIOQSIZE, &public_usage) && public_usage >= 0;
  if (public >= 0) close(public);
  int pipe_fds[2] = {-1, -1}, socket_fds[2] = {-1, -1};
  bool pipe_allowed = !pipe2(pipe_fds, O_CLOEXEC) && queued_bytes(pipe_fds);
  bool socket_allowed = !socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, socket_fds) && queued_bytes(socket_fds);
  printf("OCTANT_IOCTL_METADATA {\"baselineAllowed\":true,\"availableRefused\":%s,\"availableResult\":%d,\"availableErrno\":%d,\"usageRefused\":%s,\"usageResult\":%d,\"usageErrno\":%d,\"publicAllowed\":%s,\"pipeAllowed\":%s,\"socketAllowed\":%s}\n",
    available_refused ? "true" : "false", available_result, available_errno,
    usage_refused ? "true" : "false", usage_result, usage_errno,
    public_queries ? "true" : "false", pipe_allowed ? "true" : "false", socket_allowed ? "true" : "false");
  const char permitted[] = "permitted after";
  int ordinary = open(ROOT "/ordinary", O_WRONLY | O_TRUNC | O_CLOEXEC);
  bool marker = ordinary >= 0 && write(ordinary, permitted, sizeof(permitted) - 1) == sizeof(permitted) - 1;
  if (ordinary >= 0) close(ordinary);
  printf("OCTANT_FILEATTR_CASE {\"privateReadRefused\":%s,\"privateReadResult\":%d,\"privateReadErrno\":%d,\"privateReadOutputUnchanged\":%s,\"privateRefused\":%s,\"privateResult\":%d,\"privateErrno\":%d,\"publicChanged\":%s,\"publicRestored\":%s,\"permittedWrite\":%s}\n",
    private_read_refused ? "true" : "false", observation, read_failure,
    private_output_unchanged ? "true" : "false", private_refused ? "true" : "false", mutation, failure, public_changed ? "true" : "false",
    public_restored ? "true" : "false", marker ? "true" : "false");
  return private_read_refused && private_output_unchanged && private_refused && public_changed && public_restored && marker &&
    available_refused && usage_refused && public_queries && pipe_allowed && socket_allowed ? 0 : 18;
}
