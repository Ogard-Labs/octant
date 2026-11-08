/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define ROOT "/tmp/octant-policy-broker"
#define KEY ROOT "/home/.ssh/deployment"
int main(void)
{
  alarm(12);
  /* The relay must close its broker, enrollment and control descriptors. */
  for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) return 1;
  int held = open(KEY, O_RDONLY | O_CLOEXEC);
  int alias = open(ROOT "/alias", O_RDONLY | O_CLOEXEC);
  char bytes[64];
  if (held < 0 || alias < 0 || pread(held, bytes, sizeof(bytes), 0) <= 0) return 2;
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
  close(public); close(alias); close(held);
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
  puts("OCTANT_ORIGINAL_POLICY_WORKLOAD passed");
  return 0;
}
