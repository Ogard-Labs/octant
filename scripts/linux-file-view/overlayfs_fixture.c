/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

#define ROOT "/tmp/octant-policy-broker"
#define OVERLAY ROOT "/home"
#define LOWER ROOT "/overlay/lower"
#define UPPER ROOT "/overlay/upper"
#define WORK ROOT "/overlay/work"
#define LOWER_KEY LOWER "/.ssh/deployment"
#define UPPER_KEY UPPER "/.ssh/deployment"
#define VISIBLE_KEY OVERLAY "/.ssh/deployment"
static const char original[] = "synthetic overlay lower bytes";

static bool directory(const char *path)
{
  if (!mkdir(path, 0700)) return true;
  if (errno != EEXIST) return false;
  struct stat identity;
  return !lstat(path, &identity) && S_ISDIR(identity.st_mode);
}

static bool exact_file(const char *path, struct stat *identity)
{
  char bytes[sizeof(original)];
  int file = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (file < 0) return false;
  bool passed = fstat(file, identity) == 0 && S_ISREG(identity->st_mode) &&
    read(file, bytes, sizeof(bytes)) == (ssize_t)sizeof(original) - 1 &&
    !memcmp(bytes, original, sizeof(original) - 1);
  close(file);
  return passed;
}

static bool overlay_mounted(void)
{
  struct statfs filesystem;
  return !statfs(OVERLAY, &filesystem) &&
    (unsigned long)filesystem.f_type == (unsigned long)OVERLAYFS_SUPER_MAGIC;
}

static int mount_fixture(void)
{
  alarm(3);
  char tree[256], lower_ssh[256], upper_ssh[256], options[1024];
  if (snprintf(tree, sizeof(tree), ROOT "/overlay") >= (int)sizeof(tree) ||
      snprintf(lower_ssh, sizeof(lower_ssh), LOWER "/.ssh") >= (int)sizeof(lower_ssh) ||
      snprintf(upper_ssh, sizeof(upper_ssh), UPPER "/.ssh") >= (int)sizeof(upper_ssh) ||
      !directory(ROOT) || !directory(tree) || !directory(LOWER) ||
      !directory(UPPER) || !directory(WORK) || !directory(lower_ssh) ||
      !directory(upper_ssh) || !directory(OVERLAY)) return 2;
  int lower = open(LOWER_KEY, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lower < 0 || write(lower, original, sizeof(original) - 1) != (ssize_t)sizeof(original) - 1 ||
      fsync(lower) || close(lower)) return 3;
  if (snprintf(options, sizeof(options),
      "lowerdir=%s,upperdir=%s,workdir=%s,index=off,metacopy=off", LOWER, UPPER, WORK) >=
      (int)sizeof(options)) return 4;
  bool mounted = mount("overlay", OVERLAY, "overlay",
      MS_NODEV | MS_NOSUID | MS_NOEXEC, options) == 0;
  struct stat lower_identity = {0}, visible_identity = {0};
  struct statfs filesystem = {0};
  bool visible = mounted && !statfs(OVERLAY, &filesystem) &&
      (unsigned long)filesystem.f_type == (unsigned long)OVERLAYFS_SUPER_MAGIC &&
      exact_file(VISIBLE_KEY, &visible_identity) && exact_file(LOWER_KEY, &lower_identity);
  struct stat companion;
  bool absent = lstat(VISIBLE_KEY ".pub", &companion) < 0 && errno == ENOENT;
  printf("{\"status\":\"overlayfs-fixture-setup\",\"mounted\":%s,\"overlayFs\":%s,\"lowerVisible\":%s,\"initialCompanionAbsent\":%s}\n",
    mounted ? "true" : "false", visible ? "true" : "false",
    visible ? "true" : "false", absent ? "true" : "false");
  return visible && absent ? 0 : 5;
}

static int check_copyup(void)
{
  alarm(3);
  struct stat lower_identity = {0}, upper_identity = {0};
  bool before_transition = overlay_mounted() && exact_file(LOWER_KEY, &lower_identity) &&
      exact_file(UPPER_KEY, &upper_identity) &&
      (lower_identity.st_dev != upper_identity.st_dev || lower_identity.st_ino != upper_identity.st_ino);
  printf("{\"status\":\"overlayfs-pretransition-check\",\"copyUpBeforeTransition\":%s,\"upperBytesMatch\":%s,\"distinctUpperObject\":%s}\n",
    before_transition ? "true" : "false",
    before_transition ? "true" : "false",
    before_transition ? "true" : "false");
  return before_transition ? 0 : 6;
}

static int inspect_unmount(void)
{
  alarm(3);
  struct stat lower_identity = {0}, upper_identity = {0}, visible_identity = {0};
  bool copy_exists = overlay_mounted() && exact_file(UPPER_KEY, &upper_identity);
  bool lower_unchanged = exact_file(LOWER_KEY, &lower_identity);
  bool visible_unchanged = exact_file(VISIBLE_KEY, &visible_identity);
  bool content_unchanged = copy_exists && lower_unchanged && visible_unchanged &&
      (lower_identity.st_dev != upper_identity.st_dev || lower_identity.st_ino != upper_identity.st_ino);
  bool unmounted = overlay_mounted() && umount2(OVERLAY, 0) == 0 && !overlay_mounted();
  printf("{\"status\":\"overlayfs-disposable-repro\",\"upperCopyAfterDeniedWrite\":%s,\"contentUnchanged\":%s,\"distinctUpperObject\":%s,\"unmounted\":%s,\"productionReady\":false}\n",
    copy_exists ? "true" : "false", content_unchanged ? "true" : "false",
    content_unchanged ? "true" : "false", unmounted ? "true" : "false");
  return copy_exists && content_unchanged && unmounted ? 0 : 7;
}

static int unmount_fixture(void)
{
  alarm(3);
  bool unmounted = !overlay_mounted() || (umount2(OVERLAY, 0) == 0 && !overlay_mounted());
  printf("{\"status\":\"overlayfs-cleanup\",\"unmounted\":%s}\n", unmounted ? "true" : "false");
  return unmounted ? 0 : 8;
}

int main(int count, char **arguments)
{
  if (count != 2) return 1;
  if (!strcmp(arguments[1], "mount")) return mount_fixture();
  if (!strcmp(arguments[1], "check-copyup")) return check_copyup();
  if (!strcmp(arguments[1], "inspect-unmount")) return inspect_unmount();
  if (!strcmp(arguments[1], "unmount")) return unmount_fixture();
  return 1;
}
