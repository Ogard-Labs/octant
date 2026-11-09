/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define ROOT "/tmp/octant-policy-broker"
#define KEY ROOT "/home/.ssh/deployment"
#define STAGE ROOT "/overlay-copyup-stage"
static const char attempted[] = "denied first write";

int main(void)
{
  alarm(10);
  for (int fd = 3; fd < 64; fd++)
    if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) return 2;
  /* OverlayFS must copy the lower file to its private upper layer on this
   * writable open, before the owner publishes the companion policy rule. */
  int file = open(KEY, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (file < 0) {
    printf("{\"status\":\"overlayfs-workload\",\"openSucceeded\":false,\"errno\":%d}\n", errno);
    return 3;
  }
  int stage = open(STAGE, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (stage < 0 || close(stage)) { close(file); return 4; }
  bool companion = false;
  for (unsigned i = 0; i < 800; i++) {
    struct timespec pause = {.tv_nsec = 10000000};
    if (!access(KEY ".pub", F_OK)) { companion = true; break; }
    nanosleep(&pause, NULL);
  }
  errno = 0;
  ssize_t written = companion ? write(file, attempted, sizeof(attempted) - 1) : -1;
  int write_error = errno;
  close(file);
  bool refused = companion && written == -1 && write_error == EACCES;
  printf("{\"status\":\"overlayfs-workload\",\"openSucceeded\":true,\"companionPublished\":%s,\"writeRefused\":%s,\"writeErrno\":%d}\n",
    companion ? "true" : "false", refused ? "true" : "false", write_error);
  return refused ? 0 : 5;
}
