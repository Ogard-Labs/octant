/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <linux/posix_acl_xattr.h>
#include <linux/posix_acl.h>
#include <time.h>
#include <unistd.h>

#define ROOT "/tmp/octant-policy-broker"
#define KEY ROOT "/home/.ssh/deployment"
#define METADATA_BEFORE ROOT "/metadata-before"
static const char attribute[] = "synthetic attribute";
static const char *private_attributes[] = {
  "user.octant.read", "user.octant.write", "user.octant.remove",
};
static bool metadata_case(const char *name, bool passed)
{
  int failure = passed ? 0 : errno;
  printf("OCTANT_METADATA_CASE {\"case\":\"%s\",\"passed\":%s,\"failureErrno\":%d}\n", name, passed ? "true" : "false", failure);
  return passed;
}
static bool metadata_controls(int held, int public)
{
  bool passed = true;
  struct stat identity;
  char bytes[1024];
  errno = 0;
  passed = metadata_case("held-stat-refused", fstat(held, &identity) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("path-stat-refused", stat(KEY, &identity) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("link-stat-refused", lstat(ROOT "/home/.ssh/id_link", &identity) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("link-text-refused", readlink(ROOT "/home/.ssh/id_link", bytes, sizeof(bytes)) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("held-xattr-refused", fgetxattr(held, private_attributes[0], bytes, sizeof(bytes)) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("path-xattr-refused", getxattr(KEY, private_attributes[0], bytes, sizeof(bytes)) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("xattr-list-refused", flistxattr(held, bytes, sizeof(bytes)) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("xattr-write-refused", fsetxattr(held, private_attributes[1], "must not replace", 16, 0) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("xattr-remove-refused", fremovexattr(held, private_attributes[2]) == -1 && errno == EACCES) && passed;
  struct {
    struct posix_acl_xattr_header header;
    struct posix_acl_xattr_entry entries[3];
  } acl = {
    .header = {.a_version = POSIX_ACL_XATTR_VERSION},
    .entries = {
      {.e_tag = ACL_USER_OBJ, .e_perm = 6, .e_id = ACL_UNDEFINED_ID},
      {.e_tag = ACL_GROUP_OBJ, .e_perm = 4, .e_id = ACL_UNDEFINED_ID},
      {.e_tag = ACL_OTHER, .e_perm = 4, .e_id = ACL_UNDEFINED_ID},
    },
  };
  errno = 0;
  passed = metadata_case("acl-write-refused", fsetxattr(held, "system.posix_acl_access", &acl, sizeof(acl), 0) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("acl-remove-refused", fremovexattr(held, "system.posix_acl_access") == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("held-mode-refused", fchmod(held, 0640) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("path-mode-refused", chmod(KEY, 0644) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("held-owner-refused", fchown(held, getuid(), getgid()) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("path-owner-refused", chown(KEY, getuid(), getgid()) == -1 && errno == EACCES) && passed;
  const struct timespec changed_times[2] = {{.tv_sec = 123456789}, {.tv_sec = 123456790}};
  errno = 0;
  passed = metadata_case("held-time-refused", futimens(held, changed_times) == -1 && errno == EACCES) && passed;
  errno = 0;
  passed = metadata_case("path-time-refused", utimensat(AT_FDCWD, KEY, changed_times, 0) == -1 && errno == EACCES) && passed;
  bool public_metadata = !fstat(public, &identity) && S_ISREG(identity.st_mode) &&
    !lstat(ROOT "/home/.ssh/link.pub", &identity) && S_ISLNK(identity.st_mode) &&
    readlink(ROOT "/home/.ssh/link.pub", bytes, sizeof(bytes)) == (ssize_t)strlen("deployment.pub") &&
    !memcmp(bytes, "deployment.pub", strlen("deployment.pub"));
  passed = metadata_case("public-metadata-allowed", public_metadata) && passed;
  bool public_attributes = !fsetxattr(public, "user.octant.public", attribute, sizeof(attribute) - 1, 0) &&
    fgetxattr(public, "user.octant.public", bytes, sizeof(bytes)) == sizeof(attribute) - 1 &&
    !memcmp(bytes, attribute, sizeof(attribute) - 1) && flistxattr(public, bytes, sizeof(bytes)) > 0 &&
    !fremovexattr(public, "user.octant.public") &&
    !fsetxattr(public, "system.posix_acl_access", &acl, sizeof(acl), 0);
  passed = metadata_case("public-xattr-acl-allowed", public_attributes) && passed;
  // In the capsule, the trusted namespace refuses before the final LSM check.
  // The unused prepared read must still end, allowing the next public query.
  errno = 0;
  bool absent = fgetxattr(public, "trusted.octant.absent", bytes, sizeof(bytes)) == -1 && errno == ENODATA;
  passed = metadata_case("public-error-clears-scope", absent && !fstat(public, &identity)) && passed;
  bool public_changes = !fchmod(public, 0640) && !chmod(KEY ".pub", 0600) &&
    !fchown(public, getuid(), getgid()) && !chown(KEY ".pub", getuid(), getgid()) &&
    !futimens(public, changed_times) && !utimensat(AT_FDCWD, KEY ".pub", changed_times, 0) &&
    !fstat(public, &identity) && (identity.st_mode & 0777) == 0600 &&
    identity.st_uid == getuid() && identity.st_gid == getgid() &&
    identity.st_atim.tv_sec == changed_times[0].tv_sec && identity.st_atim.tv_nsec == 0 &&
    identity.st_mtim.tv_sec == changed_times[1].tv_sec && identity.st_mtim.tv_nsec == 0;
  passed = metadata_case("public-mode-owner-time-allowed", public_changes) && passed;
  return passed;
}

/* The unconfined owner runs this only after the enrolled command has exited.
 * It verifies refusals before effects rather than trusting an errno alone. */
static int verify_metadata(void)
{
  struct stat identity = {0}, before = {0};
  char bytes[128];
  int saved = open(METADATA_BEFORE, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool baseline = saved >= 0 && read(saved, &before, sizeof(before)) == sizeof(before);
  if (saved >= 0) close(saved);
  bool unchanged = baseline && !stat(KEY, &identity) &&
    identity.st_dev == before.st_dev && identity.st_ino == before.st_ino &&
    identity.st_mode == before.st_mode && identity.st_uid == before.st_uid && identity.st_gid == before.st_gid &&
    identity.st_atim.tv_sec == before.st_atim.tv_sec && identity.st_atim.tv_nsec == before.st_atim.tv_nsec &&
    identity.st_mtim.tv_sec == before.st_mtim.tv_sec && identity.st_mtim.tv_nsec == before.st_mtim.tv_nsec &&
    identity.st_ctim.tv_sec == before.st_ctim.tv_sec && identity.st_ctim.tv_nsec == before.st_ctim.tv_nsec;
  for (unsigned i = 0; i < sizeof(private_attributes) / sizeof(private_attributes[0]); i++)
    if (getxattr(KEY, private_attributes[i], bytes, sizeof(bytes)) != sizeof(attribute) - 1 ||
        memcmp(bytes, attribute, sizeof(attribute) - 1)) unchanged = false;
  printf("OCTANT_METADATA_OWNER {\"pid\":%ld,\"parent\":%ld,\"unchanged\":%s}\n", (long)getpid(), (long)getppid(), unchanged ? "true" : "false");
  return unchanged ? 0 : 1;
}
/* The session proof uses pipes, never a terminal/control descriptor. */
static int session_case(const char *mode, const char *root, const char *receipts)
{
  char path[512];
  const char *home = getenv("HOME"), *search = getenv("PATH"), *language = getenv("LANG");
  if (getenv("OCTANT_TEST_SECRET") || getenv("OPENAI_API_KEY") || getenv("BUN_JSC_useFTLJIT") ||
      !home || strcmp(home, "/tmp") || !search || strcmp(search, "/usr/bin:/bin") ||
      !language || strcmp(language, "C")) return 80;
  if (fcntl(3, F_GETFD) != -1 || errno != EBADF) return 71;
  if (snprintf(path, sizeof(path), "%s/private-marker", receipts) >= (int)sizeof(path)) return 72;
  int leaked = open(path, O_RDONLY | O_CLOEXEC);
  if (leaked >= 0) { close(leaked); return 73; }
  if (snprintf(path, sizeof(path), "%s/must-not-create", receipts) >= (int)sizeof(path)) return 72;
  leaked = open(path, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
  if (leaked >= 0) { close(leaked); return 74; }
  if (snprintf(path, sizeof(path), "%s/session-stage", root) >= (int)sizeof(path)) return 72;
  int stage = open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (stage < 0) return 75;
  close(stage);
  if (!strcmp(mode, "--session-exit")) return 7;
  if (!strcmp(mode, "--session-wait")) { for (;;) pause(); }
  if (strcmp(mode, "--session-echo")) return 76;
  char bytes[8192];
  size_t total = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 || total > 1024 * 1024) return 77;
    if (!count) break;
    total += (size_t)count;
    for (int output = STDOUT_FILENO; output <= STDERR_FILENO; output++) {
      ssize_t offset = 0;
      while (offset < count) {
        ssize_t written = write(output, bytes + offset, (size_t)(count - offset));
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return 78;
        offset += written;
      }
    }
  }
  return total == 1024 * 1024 ? 0 : 79;
}
int main(int argc, char **argv)
{
  if (argc == 4 && !strncmp(argv[1], "--session-", 10)) return session_case(argv[1], argv[2], argv[3]);
  alarm(12);
  if (argc == 2 && !strcmp(argv[1], "--verify-metadata")) return verify_metadata();
  if (argc != 1) return 19;
  /* The relay must close its broker, enrollment and control descriptors. */
  for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) return 1;
  int held = open(KEY, O_RDONLY | O_CLOEXEC);
  int alias = open(ROOT "/alias", O_RDONLY | O_CLOEXEC);
  char bytes[64];
  if (held < 0 || alias < 0 || pread(held, bytes, sizeof(bytes), 0) <= 0) return 2;
  for (unsigned i = 0; i < sizeof(private_attributes) / sizeof(private_attributes[0]); i++)
    if (fsetxattr(held, private_attributes[i], attribute, sizeof(attribute) - 1, 0)) {
      printf("OCTANT_METADATA_SEED {\"attribute\":%u,\"errno\":%d}\n", i, errno);
      return 20;
    }
  // Capture metadata after the admitted read/xattr seed, before the companion
  // exists. The independent owner compares effects even if the workload fails.
  struct stat before = {0};
  int saved = open(METADATA_BEFORE, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (saved < 0 || fstat(held, &before) || write(saved, &before, sizeof(before)) != sizeof(before)) {
    if (saved >= 0) close(saved);
    return 21;
  }
  close(saved);
  int stage = open(ROOT "/stage", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (stage < 0) return 3;
  close(stage);
  bool present = false;
  for (unsigned i = 0; i < 800; i++) {
    if (!access(KEY ".pub", F_OK)) { present = true; break; }
    struct timespec pause = {.tv_nsec = 10000000}; nanosleep(&pause, NULL);
  }
  if (!present) return 4;
  errno = 0;
  if (pread(held, bytes, sizeof(bytes), 0) != -1 || errno != EACCES) return 5;
  errno = 0;
  if (pread(alias, bytes, sizeof(bytes), 0) != -1 || errno != EACCES) return 6;
  errno = 0;
  void *mapped = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, held, 0);
  if (mapped != MAP_FAILED || errno != EACCES) return 7;
  int ordinary = open(ROOT "/ordinary", O_WRONLY | O_TRUNC | O_CLOEXEC);
  const char permitted[] = "permitted after";
  if (ordinary < 0 || write(ordinary, permitted, sizeof(permitted) - 1) != sizeof(permitted) - 1) return 8;
  close(ordinary);
  int public = open(KEY ".pub", O_RDWR | O_CLOEXEC);
  if (public < 0 || read(public, bytes, sizeof(bytes)) <= 0 || pwrite(public, "P", 1, 0) != 1) return 9;
  errno = 0;
  if (unlink(KEY ".pub") != -1 || errno != EACCES) return 10;
  errno = 0;
  if (rename(ROOT "/home/.ssh", ROOT "/home/moved") != -1 || errno != EACCES) return 11;
  if (unlink(ROOT "/unrelated.pub") ||
      unlink(ROOT "/home/.ssh/id_independent.pub") ||
      rename(ROOT "/ordinary", ROOT "/renamed") ||
      rename(ROOT "/renamed", ROOT "/ordinary") || rmdir(ROOT "/empty")) return 12;
  int created = open(ROOT "/home/.ssh/new.pub", O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
  if (created < 0 || write(created, "new public", 10) != 10) return 13;
  close(created);
  int private = open(ROOT "/home/.ssh/id_independent", O_RDONLY | O_CLOEXEC);
  if (private < 0) return 14;
  errno = 0;
  if (read(private, bytes, sizeof(bytes)) != -1 || errno != EACCES) return 15;
  close(private);
  DIR *directory = opendir(ROOT "/home/.aws/sso/cache");
  bool refused = !directory && errno == EACCES;
  if (directory) {
    errno = 0;
    refused = readdir(directory) == NULL && errno == EACCES;
    closedir(directory);
  }
  if (!refused) return 17;
  bool metadata = metadata_controls(held, public);
  close(public); close(alias); close(held);
  if (!metadata) return 18;
  puts("OCTANT_ORIGINAL_POLICY_WORKLOAD passed");
  return 0;
}
