/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/fiemap.h>
#include <linux/magic.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
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
struct baseline { struct stat identity; unsigned int flags; unsigned int generation; };
static const char *private_created[] = {
  ROOT "/home/.ssh/id_created_open", ROOT "/home/.ssh/id_created_node",
  ROOT "/home/.ssh/id_created_directory", ROOT "/home/.ssh/id_created_symlink",
  ROOT "/home/.ssh/id_created_alias", ROOT "/private-source-link",
};
static const char public_created[] = "permitted creation";


static bool same_time(struct timespec left, struct timespec right)
{
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}
static int verify(void)
{
  struct baseline before = {0};
  struct stat after = {0};
  unsigned int flags = 0, generation = 0;
  int saved = open(BASELINE, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool loaded = saved >= 0 && read(saved, &before, sizeof(before)) == sizeof(before);
  if (saved >= 0) close(saved);
  int held = open(KEY, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool measured = loaded && held >= 0 && !fstat(held, &after) &&
    !ioctl(held, FS_IOC_GETFLAGS, &flags) && !ioctl(held, FS_IOC_GETVERSION, &generation);
  bool flags_unchanged = measured && flags == before.flags;
  bool generation_unchanged = measured && generation == before.generation;
  bool stat_unchanged = measured &&
    after.st_dev == before.identity.st_dev && after.st_ino == before.identity.st_ino &&
    after.st_nlink == before.identity.st_nlink &&
    after.st_mode == before.identity.st_mode && after.st_uid == before.identity.st_uid &&
    after.st_gid == before.identity.st_gid && after.st_size == before.identity.st_size &&
    same_time(after.st_atim, before.identity.st_atim) &&
    same_time(after.st_mtim, before.identity.st_mtim) &&
    same_time(after.st_ctim, before.identity.st_ctim);
  if (held >= 0) close(held);
  bool names_absent = true;
  for (unsigned i = 0; i < sizeof(private_created) / sizeof(private_created[0]); i++) {
    struct stat entry;
    errno = 0;
    if (lstat(private_created[i], &entry) != -1 || errno != ENOENT) names_absent = false;
  }
  char bytes[sizeof(public_created)] = {0};
  int publication = open(ROOT "/home/.ssh/created.pub", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool public_persisted = publication >= 0 && read(publication, bytes, sizeof(bytes)) == sizeof(public_created) - 1 &&
    !memcmp(bytes, public_created, sizeof(public_created) - 1);
  if (publication >= 0) close(publication);
  bool unchanged = flags_unchanged && stat_unchanged && generation_unchanged && names_absent && public_persisted;
  printf("OCTANT_FILEATTR_OWNER {\"pid\":%ld,\"parent\":%ld,\"measured\":%s,\"flagsUnchanged\":%s,\"generationUnchanged\":%s,\"createdNamesAbsent\":%s,\"publicCreationPersisted\":%s,\"statUnchanged\":%s,\"unchanged\":%s}\n",
    (long)getpid(), (long)getppid(), measured ? "true" : "false", flags_unchanged ? "true" : "false", generation_unchanged ? "true" : "false", names_absent ? "true" : "false", public_persisted ? "true" : "false",
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

static bool refused_creation(const char *kind, int result, int error)
{
  bool refused = result == -1 && error == EACCES;
  printf("OCTANT_CREATE_CASE {\"kind\":\"%s\",\"result\":%d,\"errno\":%d,\"refused\":%s}\n",
    kind, result, error, refused ? "true" : "false");
  return refused;
}
static bool creation_controls(void)
{
  int public = open(ROOT "/home/.ssh/created.pub", O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
  bool published = public >= 0 && write(public, public_created, sizeof(public_created) - 1) == sizeof(public_created) - 1;
  if (public >= 0) close(public);
  bool directory = !mkdir(ROOT "/created-directory", 0700);
  bool directory_removed = directory && !rmdir(ROOT "/created-directory");
  bool fifo = !mkfifo(ROOT "/created-pipe", 0600);
  struct stat pipe_identity;
  bool pipe_observed = fifo && !lstat(ROOT "/created-pipe", &pipe_identity) && S_ISFIFO(pipe_identity.st_mode);
  bool pipe_removed = fifo && !unlink(ROOT "/created-pipe");
  const char target[] = "home/.ssh/deployment.pub";
  char target_read[sizeof(target)] = {0};
  bool symbolic = !symlink(target, ROOT "/created-link");
  bool symbolic_observed = symbolic && readlink(ROOT "/created-link", target_read, sizeof(target_read)) == sizeof(target) - 1 &&
    !memcmp(target, target_read, sizeof(target) - 1);
  bool symbolic_removed = symbolic && !unlink(ROOT "/created-link");
  struct stat source = {0}, alias = {0};
  bool hardlink = !link(KEY ".pub", ROOT "/created-alias");
  bool same_inode = hardlink && !stat(KEY ".pub", &source) && !stat(ROOT "/created-alias", &alias) &&
    source.st_dev == alias.st_dev && source.st_ino == alias.st_ino && source.st_nlink >= 2;
  bool alias_removed = hardlink && !unlink(ROOT "/created-alias");
  int temporary = open(ROOT, O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
  char descriptor[64];
  snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", temporary);
  bool temporary_written = temporary >= 0 && write(temporary, "ok", 2) == 2;
  bool temporary_linked = temporary_written && !linkat(AT_FDCWD, descriptor, AT_FDCWD,
    ROOT "/temporary-alias", AT_SYMLINK_FOLLOW);
  bool temporary_observed = temporary_linked && !fstat(temporary, &source) && !stat(ROOT "/temporary-alias", &alias) &&
    source.st_dev == alias.st_dev && source.st_ino == alias.st_ino && alias.st_size == 2;
  bool temporary_removed = temporary_linked && !unlink(ROOT "/temporary-alias");
  if (temporary >= 0) close(temporary);
  printf("OCTANT_CREATE_PUBLIC {\"regularPersisted\":%s,\"directory\":%s,\"fifo\":%s,\"symlink\":%s,\"hardlinkIdentity\":%s,\"anonymousLinked\":%s}\n",
    published ? "true" : "false", directory_removed ? "true" : "false", pipe_observed && pipe_removed ? "true" : "false",
    symbolic_observed && symbolic_removed ? "true" : "false", same_inode && alias_removed ? "true" : "false",
    temporary_observed && temporary_removed ? "true" : "false");
  bool positives = published && directory_removed && pipe_observed && pipe_removed && symbolic_observed &&
    symbolic_removed && same_inode && alias_removed && temporary_observed && temporary_removed;
  errno = 0;
  int opened = open(private_created[0], O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  int error = opened < 0 ? errno : 0;
  bool denied = refused_creation("regular-open", opened < 0 ? -1 : 0, error);
  if (opened >= 0) close(opened);
  errno = 0;
  int result = mknod(private_created[1], S_IFREG | 0600, 0);
  error = result < 0 ? errno : 0;
  denied = refused_creation("regular-node", result, error) && denied;
  errno = 0;
  result = mkdir(private_created[2], 0700); error = result < 0 ? errno : 0;
  denied = refused_creation("directory", result, error) && denied;
  errno = 0;
  result = symlink("synthetic target", private_created[3]); error = result < 0 ? errno : 0;
  denied = refused_creation("symlink", result, error) && denied;
  errno = 0;
  result = link(KEY, private_created[5]); error = result < 0 ? errno : 0;
  denied = refused_creation("protected-source-link", result, error) && denied;
  // Last: an unguarded implementation could turn the public source inode into
  // a protected alias and spoil later unrelated positive controls.
  errno = 0;
  result = link(KEY ".pub", private_created[4]); error = result < 0 ? errno : 0;
  denied = refused_creation("protected-destination-link", result, error) && denied;
  return positives && denied;
}

static bool ordinary_seeks(int file, off_t size)
{
  return lseek(file, 0, SEEK_END) == size && lseek(file, 0, SEEK_DATA) == 0 &&
    lseek(file, 0, SEEK_HOLE) == size && lseek(file, 7, SEEK_SET) == 7 &&
    lseek(file, -7, SEEK_CUR) == 0;
}

// The pinned ext4 UAPI also exposes generation under this native command.
#define EXT4_NATIVE_GETVERSION _IOR('f', 3, long)
#define EXT4_NATIVE_SETVERSION _IOW('f', 4, long)
struct integer_observation { int result; int error; unsigned int value; bool unchanged; };
static struct integer_observation inode_integer(int file, unsigned int command)
{
  const unsigned int sentinel = 0x5a5a5a5a;
  unsigned int value = sentinel;
  errno = 0;
  int result = ioctl(file, command, &value);
  int error = result < 0 ? errno : 0;
  return (struct integer_observation) { .result = result, .error = error,
    .value = value, .unchanged = value == sentinel };
}
static bool inode_queries_allowed(int file)
{
  struct integer_observation legacy = inode_integer(file, FS_IOC_GETVERSION);
  struct integer_observation version = inode_integer(file, EXT4_NATIVE_GETVERSION);
  struct integer_observation block = inode_integer(file, FIGETBSZ);
  return legacy.result == 0 && version.result == 0 && legacy.value == version.value &&
    block.result == 0 && block.value > 0;
}
static bool integer_refused(struct integer_observation observation)
{
  return observation.result == -1 && observation.error == EACCES && observation.unchanged;
}

static bool generation_changes(int file)
{
  struct integer_observation before = inode_integer(file, FS_IOC_GETVERSION);
  if (before.result) return false;
  unsigned int changed = before.value ^ 0x01010101;
  bool written = !ioctl(file, FS_IOC_SETVERSION, &changed);
  struct integer_observation after = inode_integer(file, EXT4_NATIVE_GETVERSION);
  // Always restore the owned positive control, including a failed readback.
  bool restored = !ioctl(file, EXT4_NATIVE_SETVERSION, &before.value);
  struct integer_observation final = inode_integer(file, FS_IOC_GETVERSION);
  return written && after.result == 0 && after.value == changed && restored &&
    final.result == 0 && final.value == before.value;
}

struct extent_observation { int result; int error; unsigned int count; bool unchanged; };
static struct extent_observation extent_count(int file)
{
  struct fiemap request = { .fm_length = UINT64_MAX, .fm_mapped_extents = 0x5a5a5a5a };
  struct fiemap before = request;
  errno = 0;
  int result = ioctl(file, FS_IOC_FIEMAP, &request);
  int error = result < 0 ? errno : 0;
  return (struct extent_observation) { .result = result, .error = error,
    .count = request.fm_mapped_extents, .unchanged = !memcmp(&before, &request, sizeof(request)) };
}

struct seek_observation { off_t result; int error; bool refused; };
static struct seek_observation protected_seek(int file, int origin)
{
  bool reset = lseek(file, 0, SEEK_SET) == 0;
  errno = 0;
  off_t result = lseek(file, 0, origin);
  int error = result < 0 ? errno : 0;
  return (struct seek_observation) { .result = result, .error = error,
    .refused = reset && result == -1 && error == EACCES && lseek(file, 0, SEEK_CUR) == 0 };
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
  if (!ordinary_seeks(held, before.identity.st_size)) return 8;
  struct extent_observation before_extents = extent_count(held);
  if (before_extents.result || !before_extents.count) return 9;
  if (!inode_queries_allowed(held)) return 10;
  struct integer_observation initial_generation = inode_integer(held, FS_IOC_GETVERSION);
  if (initial_generation.result) return 11;
  before.generation = initial_generation.value;
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
  struct integer_observation private_legacy = inode_integer(held, FS_IOC_GETVERSION);
  struct integer_observation private_version = inode_integer(held, EXT4_NATIVE_GETVERSION);
  struct integer_observation private_block = inode_integer(held, FIGETBSZ);
  struct extent_observation private_extents = extent_count(held);
  bool extents_refused = private_extents.result == -1 && private_extents.error == EACCES && private_extents.unchanged;
  struct seek_observation seek_end = protected_seek(held, SEEK_END);
  struct seek_observation seek_data = protected_seek(held, SEEK_DATA);
  struct seek_observation seek_hole = protected_seek(held, SEEK_HOLE);
  bool private_position = lseek(held, 7, SEEK_SET) == 7 && lseek(held, -7, SEEK_CUR) == 0;
  unsigned int legacy_generation = before.generation ^ 0x01010101;
  unsigned int native_generation = before.generation ^ 0x02020202;
  errno = 0;
  int legacy_set = ioctl(held, FS_IOC_SETVERSION, &legacy_generation);
  int legacy_set_errno = legacy_set < 0 ? errno : 0;
  errno = 0;
  int native_set = ioctl(held, EXT4_NATIVE_SETVERSION, &native_generation);
  int native_set_errno = native_set < 0 ? errno : 0;
  bool generations_refused = legacy_set == -1 && legacy_set_errno == EACCES &&
    native_set == -1 && native_set_errno == EACCES;
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
  struct stat public_identity;
  bool public_seeks = public >= 0 && !fstat(public, &public_identity) && ordinary_seeks(public, public_identity.st_size);
  bool public_generations = generation_changes(public);
  bool public_inode_queries = inode_queries_allowed(public);
  struct extent_observation public_extents = extent_count(public);
  bool extents_allowed = public_extents.result == 0 && public_extents.count > 0;
  if (public >= 0) close(public);
  printf("OCTANT_INODE_GENERATION_WRITE {\"privateRefused\":%s,\"legacyResult\":%d,\"legacyErrno\":%d,\"nativeResult\":%d,\"nativeErrno\":%d,\"publicChangedRestored\":%s}\n",
    generations_refused ? "true" : "false", legacy_set, legacy_set_errno, native_set, native_set_errno,
    public_generations ? "true" : "false");
  printf("OCTANT_INODE_IOCTL_METADATA {\"baselineAllowed\":true,\"legacyRefused\":%s,\"legacyResult\":%d,\"legacyErrno\":%d,\"versionRefused\":%s,\"versionResult\":%d,\"versionErrno\":%d,\"blockRefused\":%s,\"blockResult\":%d,\"blockErrno\":%d,\"publicAllowed\":%s}\n",
    integer_refused(private_legacy) ? "true" : "false", private_legacy.result, private_legacy.error,
    integer_refused(private_version) ? "true" : "false", private_version.result, private_version.error,
    integer_refused(private_block) ? "true" : "false", private_block.result, private_block.error,
    public_inode_queries ? "true" : "false");
  printf("OCTANT_FIEMAP_METADATA {\"baselineAllowed\":true,\"privateRefused\":%s,\"privateResult\":%d,\"privateErrno\":%d,\"outputUnchanged\":%s,\"publicAllowed\":%s}\n",
    extents_refused ? "true" : "false", private_extents.result, private_extents.error,
    private_extents.unchanged ? "true" : "false", extents_allowed ? "true" : "false");
  printf("OCTANT_LLSEEK_METADATA {\"baselineAllowed\":true,\"endRefused\":%s,\"endResult\":%lld,\"endErrno\":%d,\"dataRefused\":%s,\"dataResult\":%lld,\"dataErrno\":%d,\"holeRefused\":%s,\"holeResult\":%lld,\"holeErrno\":%d,\"positionAllowed\":%s,\"publicAllowed\":%s}\n",
    seek_end.refused ? "true" : "false", (long long)seek_end.result, seek_end.error,
    seek_data.refused ? "true" : "false", (long long)seek_data.result, seek_data.error,
    seek_hole.refused ? "true" : "false", (long long)seek_hole.result, seek_hole.error,
    private_position ? "true" : "false", public_seeks ? "true" : "false");
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
  bool creations = creation_controls();
  return creations && private_read_refused && private_output_unchanged && private_refused && public_changed && public_restored && marker &&
    available_refused && usage_refused && public_queries && pipe_allowed && socket_allowed &&
    extents_refused && extents_allowed && public_inode_queries && generations_refused && public_generations &&
    integer_refused(private_legacy) && integer_refused(private_version) && integer_refused(private_block) &&
    seek_end.refused && seek_data.refused && seek_hole.refused && private_position && public_seeks ? 0 : 18;
}
