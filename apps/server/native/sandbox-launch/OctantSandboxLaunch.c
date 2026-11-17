#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

extern char **environ;

/* Statically linked: no workload-controlled loader code runs before the wall.
 * Pin every host mount source before bubblewrap resolves any of its targets.
 * A trusted static entrypoint closes the pins before loading any payload code. */
static void refuse(void) {
  fputs("Strict launch refused: a prepared filesystem binding changed.\n", stderr);
  exit(125);
}

static uintmax_t number(const char *s) {
  char *end;
  errno = 0;
  uintmax_t n = strtoumax(s, &end, 10);
  if (errno || !*s || *end) refuse();
  return n;
}

static int pin(const char *path, const char *device, const char *inode, int flags) {
  struct open_how how = { .flags = (unsigned long long)flags,
                         .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
  int fd = (int)syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how));
  struct stat st;
  if (fd < 0 || fstat(fd, &st) || (uintmax_t)st.st_dev != number(device) ||
      (uintmax_t)st.st_ino != number(inode)) refuse();
  return fd;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--check")) {
    struct open_how how = { .flags = O_PATH | O_CLOEXEC,
                           .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    int root = (int)syscall(SYS_openat2, AT_FDCWD, "/", &how, sizeof(how));
    if (root < 0) refuse();
    close(root);
    return syscall(SYS_close_range, 3u, ~0u, 0u) ? 125 : 0;
  }
  if (argc >= 4 && !strcmp(argv[1], "--exec-close") && !strcmp(argv[2], "--")) {
    if (syscall(SYS_close_range, 3u, ~0u, 0u)) refuse();
    execvp(argv[3], &argv[3]);
    refuse();
  }
  if (argc < 6 || getuid() != geteuid() || getgid() != getegid()) refuse();
  int executable = pin(argv[1], argv[2], argv[3], O_PATH | O_CLOEXEC);
  uintmax_t count = number(argv[4]);
  if (count > 4096 || count * 4 + 6 > (uintmax_t)argc) refuse();
  int start = 5 + (int)count * 4;
  if (strcmp(argv[start], "--") || start + 1 >= argc) refuse();
  char **args = &argv[start];
  args[0] = argv[1];
  for (uintmax_t i = 0; i < count; ++i) {
    int at = 5 + (int)i * 4;
    uintmax_t index = number(argv[at]);
    if (index >= (uintmax_t)(argc - start - 1)) refuse();
    int filter = !strcmp(args[index + 1], "@filter");
    int fd = pin(argv[at + 1], argv[at + 2], argv[at + 3], filter ? O_RDONLY : O_PATH);
    char *name;
    if ((filter ? asprintf(&name, "%d", fd) : asprintf(&name, "/proc/self/fd/%d", fd)) < 0) refuse();
    args[index + 1] = name;
  }
  /* The host's dynamic bubblewrap loader must also start clean. Commands may
   * still set their own environment after the confinement is installed. */
  for (char **p = environ; *p;) {
    if (!strncmp(*p, "LD_", 3) || !strncmp(*p, "GLIBC_TUNABLES=", 15) ||
        !strncmp(*p, "NODE_OPTIONS=", 13) || !strncmp(*p, "BUN_OPTIONS=", 12)) {
      char *equal = strchr(*p, '=');
      if (!equal) refuse();
      char *key = strndup(*p, (size_t)(equal - *p));
      if (!key || unsetenv(key)) refuse();
      free(key);
      p = environ;
    } else ++p;
  }
  if (syscall(SYS_execveat, executable, "", args, environ, AT_EMPTY_PATH) < 0) refuse();
  return 125;
}
