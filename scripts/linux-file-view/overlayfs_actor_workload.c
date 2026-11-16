/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define ROOT "/tmp/octant-policy-broker"
static const char original[] = "synthetic overlay lower bytes";

static bool refused(const char *path)
{
  unsigned char bytes[64], sentinel[64];
  memset(bytes, 0xa5, sizeof(bytes));
  memcpy(sentinel, bytes, sizeof(bytes));
  errno = 0;
  int file = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (file < 0) return errno == EACCES && !memcmp(bytes, sentinel, sizeof(bytes));
  errno = 0;
  ssize_t size = read(file, bytes, sizeof(bytes));
  int error = errno;
  close(file);
  return size == -1 && error == EACCES && !memcmp(bytes, sentinel, sizeof(bytes));
}

int main(void)
{
  alarm(10);
  for (int fd = 3; fd < 64; fd++)
    if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) return 2;
  bool direct = refused(ROOT "/overlay/lower/.ssh/deployment");
  bool alias = refused(ROOT "/home/.ssh/deployment");
  char bytes[sizeof(original)];
  int file = open(ROOT "/home/public", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool ordinary = file >= 0 && read(file, bytes, sizeof(bytes)) == (ssize_t)sizeof(original) - 1 &&
    !memcmp(bytes, original, sizeof(original) - 1);
  if (file >= 0) close(file);
  printf("{\"status\":\"overlayfs-actor-workload\",\"directPrivateRefused\":%s,\"overlayPrivateRefused\":%s,\"ordinaryOverlayRead\":%s}\n",
    direct ? "true" : "false", alias ? "true" : "false", ordinary ? "true" : "false");
  return direct && alias && ordinary ? 0 : 3;
}
