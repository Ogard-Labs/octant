/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
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
  return passed;
}

/* The unconfined owner runs this only after the enrolled command has exited.
 * It verifies refusals before effects rather than trusting an errno alone. */
static int verify_metadata(void)
{
  struct stat identity;
  char bytes[128];
  if (stat(KEY, &identity) || (identity.st_mode & 0777) != 0600) return 1;
  for (unsigned i = 0; i < sizeof(private_attributes) / sizeof(private_attributes[0]); i++)
    if (getxattr(KEY, private_attributes[i], bytes, sizeof(bytes)) != sizeof(attribute) - 1 ||
        memcmp(bytes, attribute, sizeof(attribute) - 1)) return 2;
  printf("OCTANT_METADATA_OWNER {\"pid\":%ld,\"parent\":%ld,\"unchanged\":true}\n", (long)getpid(), (long)getppid());
  return 0;
}
int main(int argc, char **argv)
{
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
