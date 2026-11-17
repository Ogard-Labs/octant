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
  errno = 0;
  int private_write = open(ROOT "/home/.ssh/deployment", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  int private_write_error = errno;
  bool write_refused = private_write < 0 && private_write_error == EACCES;
  if (private_write >= 0) close(private_write);
  char bytes[sizeof(original)];
  memset(bytes, 0xa5, sizeof(bytes));
  errno = 0;
  int file = open(ROOT "/home/public", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  int open_error = errno;
  errno = 0;
  ssize_t read_result = file >= 0 ? read(file, bytes, sizeof(bytes)) : -1;
  int read_error = errno;
  bool ordinary = file >= 0 && read_result == (ssize_t)sizeof(original) - 1 &&
    !memcmp(bytes, original, sizeof(original) - 1);
  if (file >= 0) close(file);
  printf("{\"status\":\"overlayfs-actor-workload\",\"directPrivateRefused\":%s,\"overlayPrivateRefused\":%s,\"overlayPrivateWriteRefused\":%s,\"ordinaryOverlayRead\":%s,\"ordinaryOpenResult\":%d,\"ordinaryOpenErrno\":%d,\"ordinaryReadResult\":%zd,\"ordinaryReadErrno\":%d}\n",
    direct ? "true" : "false", alias ? "true" : "false", write_refused ? "true" : "false",
    ordinary ? "true" : "false",
    file < 0 ? -1 : 0, open_error, read_result, read_error);
  return direct && alias && write_refused && ordinary ? 0 : 3;
}
