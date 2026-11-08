#define FUSE_USE_VERSION 35
#define _GNU_SOURCE
#include <fuse3/fuse.h>
#include <linux/openat2.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dirent.h>
#include <signal.h>
#include <time.h>

/* Feasibility fixture only. This is not a production policy or launcher. */
static int backing = -1;
static char backing_path[PATH_MAX];

static int open_beneath(const char *path, int flags, mode_t mode) {
  struct open_how how = {
    .flags = (unsigned long long)(flags | O_CLOEXEC),
    .mode = mode & 07777,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
  };
  const char *relative = path[0] == '/' ? path + 1 : path;
  if (!*relative) relative = ".";
  return (int)syscall(SYS_openat2, backing, relative, &how, sizeof(how));
}

static int protected_path(const char *path) {
  const char *relative = path[0] == '/' ? path + 1 : path;
  const char *name = strrchr(relative, '/');
  name = name ? name + 1 : relative;
  if (!strcmp(relative, ".provider") || !strcmp(relative, ".provider/accounts") ||
      !strcmp(relative, ".provider/accounts/first")) return 0;
  if (!strncmp(relative, ".provider/", 10))
    return strncmp(relative, ".provider/accounts/first/", 25) != 0;
  if (strncmp(relative, ".ssh/", 5)) return 0;
  size_t length = strlen(name);
  if (length >= 4 && !strcmp(name + length - 4, ".pub")) return 0;
  if (!strncmp(name, "id_", 3)) return 1;
  char companion[PATH_MAX];
  if (snprintf(companion, sizeof(companion), "%s.pub", relative) >= (int)sizeof(companion)) return 1;
  int fd = open_beneath(companion, O_PATH | O_NOFOLLOW, 0);
  if (fd < 0) return errno != ENOENT;
  close(fd);
  return 1;
}

static int permitted_fd(int fd) {
  char proc[64], actual[PATH_MAX];
  snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
  ssize_t length = readlink(proc, actual, sizeof(actual) - 1);
  if (length < 0) return -errno;
  actual[length] = 0;
  size_t root_length = strlen(backing_path);
  if (strncmp(actual, backing_path, root_length) || actual[root_length] != '/') return -EACCES;
  if (protected_path(actual + root_length)) return -EACCES;
  struct stat value;
  if (fstat(fd, &value)) return -errno;
  /* A fixture cannot establish every alias of a multiply linked inode. */
  if (S_ISREG(value.st_mode) && value.st_nlink > 1) return -EACCES;
  return 0;
}

static int view_getattr(const char *path, struct stat *value, struct fuse_file_info *info) {
  (void)info;
  if (protected_path(path)) return -EACCES;
  int fd = open_beneath(path, O_PATH | O_NOFOLLOW, 0);
  if (fd < 0) return -errno;
  int status = fstat(fd, value) ? -errno : 0;
  close(fd);
  return status;
}

static int view_readdir(const char *path, void *buffer, fuse_fill_dir_t fill,
                        off_t offset, struct fuse_file_info *info, enum fuse_readdir_flags flags) {
  (void)offset; (void)info; (void)flags;
  if (protected_path(path)) return -EACCES;
  int fd = open_beneath(path, O_RDONLY | O_DIRECTORY, 0);
  if (fd < 0) return -errno;
  DIR *directory = fdopendir(fd);
  if (!directory) { int error = errno; close(fd); return -error; }
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (fill(buffer, entry->d_name, NULL, 0, 0)) break;
  }
  closedir(directory);
  return 0;
}

static int view_open(const char *path, struct fuse_file_info *info) {
  if (protected_path(path)) return -EACCES;
  int fd = open_beneath(path, info->flags, 0);
  if (fd < 0) return -errno;
  int permitted = permitted_fd(fd);
  if (permitted) { close(fd); return permitted; }
  info->fh = (unsigned long)fd;
  info->direct_io = 1;
  return 0;
}

static int view_create(const char *path, mode_t mode, struct fuse_file_info *info) {
  if (protected_path(path)) return -EACCES;
  int fd = open_beneath(path, info->flags | O_CREAT, mode);
  if (fd < 0) return -errno;
  info->fh = (unsigned long)fd;
  info->direct_io = 1;
  return 0;
}

static int view_read(const char *path, char *buffer, size_t length, off_t offset,
                     struct fuse_file_info *info) {
  (void)path;
  int fd = (int)info->fh, permitted = permitted_fd(fd);
  if (permitted) return permitted;
  ssize_t result = pread(fd, buffer, length, offset);
  return result < 0 ? -errno : (int)result;
}

static int view_write(const char *path, const char *buffer, size_t length, off_t offset,
                      struct fuse_file_info *info) {
  (void)path;
  int fd = (int)info->fh, permitted = permitted_fd(fd);
  if (permitted) return permitted;
  ssize_t result = pwrite(fd, buffer, length, offset);
  return result < 0 ? -errno : (int)result;
}

static int view_release(const char *path, struct fuse_file_info *info) {
  (void)path;
  return close((int)info->fh) ? -errno : 0;
}

static int view_readlink(const char *path, char *buffer, size_t length) {
  if (protected_path(path)) return -EACCES;
  int fd = open_beneath(path, O_PATH | O_NOFOLLOW, 0);
  if (fd < 0) return -errno;
  ssize_t result = readlinkat(fd, "", buffer, length - 1);
  int error = errno;
  close(fd);
  if (result < 0) return -error;
  buffer[result] = 0;
  return 0;
}

static int view_truncate(const char *path, off_t length, struct fuse_file_info *info) {
  if (protected_path(path)) return -EACCES;
  int fd = info ? (int)info->fh : open_beneath(path, O_WRONLY, 0);
  if (fd < 0) return -errno;
  int permitted = permitted_fd(fd);
  int result = permitted ? permitted : (ftruncate(fd, length) ? -errno : 0);
  if (!info) close(fd);
  return result;
}

static int parent_fd(const char *path, char *name) {
  char parent[PATH_MAX];
  if (strlen(path) >= sizeof(parent)) return -ENAMETOOLONG;
  strcpy(parent, path);
  char *last = strrchr(parent, '/');
  if (!last || !last[1]) return -EINVAL;
  strcpy(name, last + 1);
  if (!strcmp(name, ".") || !strcmp(name, "..")) return -EACCES;
  *last = 0;
  int fd = open_beneath(*parent ? parent : "/", O_PATH | O_DIRECTORY, 0);
  return fd < 0 ? -errno : fd;
}

static int view_rename(const char *from, const char *to, unsigned int flags) {
  if (protected_path(from) || protected_path(to)) return -EACCES;
  char from_name[PATH_MAX], to_name[PATH_MAX];
  int first = parent_fd(from, from_name);
  if (first < 0) return first;
  int second = parent_fd(to, to_name);
  if (second < 0) { close(first); return second; }
  int status = syscall(SYS_renameat2, first, from_name, second, to_name, flags) ? -errno : 0;
  close(first); close(second);
  return status;
}

static int view_unlink(const char *path) {
  if (protected_path(path)) return -EACCES;
  char name[PATH_MAX];
  int fd = parent_fd(path, name);
  if (fd < 0) return fd;
  int status = unlinkat(fd, name, 0) ? -errno : 0;
  close(fd);
  return status;
}

static int view_fsync(const char *path, int data_only, struct fuse_file_info *info) {
  (void)path;
  int fd = (int)info->fh, permitted = permitted_fd(fd);
  if (permitted) return permitted;
  return (data_only ? fdatasync(fd) : fsync(fd)) ? -errno : 0;
}

static const struct fuse_operations operations = {
  .getattr = view_getattr, .readdir = view_readdir,
  .open = view_open, .create = view_create, .read = view_read, .write = view_write,
  .release = view_release, .readlink = view_readlink, .truncate = view_truncate,
  .rename = view_rename, .unlink = view_unlink, .fsync = view_fsync,
};

int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage: fixture backing-root mountpoint owner-pid lifetime-seconds\n"); return 2; }
  char *end;
  errno = 0;
  long owner = strtol(argv[3], &end, 10);
  if (errno || !*argv[3] || *end || owner < 2 || owner > INT_MAX) return 2;
  errno = 0;
  long seconds = strtol(argv[4], &end, 10);
  if (errno || !*argv[4] || *end || seconds < 1 || seconds > 120) return 2;
  /* The launcher supplies its PID before exec: an already orphaned child must
     not adopt its replacement parent as the owner. The second check closes
     the race while arming the kernel's uncatchable parent-death signal. */
  if (getppid() != (pid_t)owner || prctl(PR_SET_PDEATHSIG, SIGKILL) ||
      getppid() != (pid_t)owner) return 2;
  timer_t lifetime;
  struct sigevent event = {.sigev_notify = SIGEV_SIGNAL, .sigev_signo = SIGKILL};
  struct itimerspec limit = {.it_value = {.tv_sec = seconds}};
  if (timer_create(CLOCK_MONOTONIC, &event, &lifetime)) { perror("fixture timer"); return 2; }
  if (timer_settime(lifetime, 0, &limit, NULL)) { perror("fixture deadline"); return 2; }
  if (getppid() != (pid_t)owner) return 2;
  if (!realpath(argv[1], backing_path)) { perror("backing root"); return 2; }
  backing = open(backing_path, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (backing < 0) { perror("backing root"); return 2; }
  char *fuse_argv[] = {argv[0], argv[2], "-f", "-s", "-o",
    "auto_unmount,default_permissions,attr_timeout=0,entry_timeout=0,negative_timeout=0"};
  if (getppid() != (pid_t)owner) return 2;
  int result = fuse_main(6, fuse_argv, &operations, NULL);
  timer_delete(lifetime);
  close(backing);
  return result;
}
