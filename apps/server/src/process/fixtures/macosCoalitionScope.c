#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

/* Darwin's versioned proc_pidinfo ABI, including its reserved words. */
struct scope_coalitions {
  uint64_t resource;
  uint64_t jetsam;
  uint64_t reserved[3];
};

static int describe(pid_t pid) {
  struct scope_coalitions scope = {0};
  if (proc_pidinfo(pid, 20, 0, &scope, sizeof(scope)) != (int)sizeof(scope)) {
    perror("coalition identity");
    return 125;
  }
  printf("{\"pid\":%d,\"resource\":\"%" PRIu64 "\",\"jetsam\":\"%" PRIu64
         "\",\"session\":%d}\n", pid, scope.resource, scope.jetsam, getsid(pid));
  fflush(stdout);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) return 125;
  if (strcmp(argv[1], "inspect") == 0) return describe((pid_t)atoi(argv[2]));
  if (strcmp(argv[1], "beat") == 0) {
    if (describe(getpid()) != 0) return 125;
    time_t deadline = time(NULL) + 15;
    for (unsigned n = 0; time(NULL) < deadline; n++) {
      int fd = open(argv[2], O_CREAT | O_WRONLY | O_TRUNC, 0600);
      if (fd < 0) return 125;
      dprintf(fd, "%u\n", n);
      close(fd);
      usleep(20000);
    }
    return 0;
  }
  if (strcmp(argv[1], "spawn") != 0 || describe(getpid()) != 0) return 125;
  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes) != 0) return 125;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID) != 0) return 125;
  char *args[] = {argv[0], "beat", argv[2], NULL};
  pid_t child;
  int error = posix_spawn(&child, argv[0], NULL, &attributes, args, environ);
  posix_spawnattr_destroy(&attributes);
  if (error != 0) { errno = error; perror("detached child"); return 125; }
  return 0;
}
