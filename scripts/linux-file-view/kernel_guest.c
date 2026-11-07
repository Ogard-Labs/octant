/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../../apps/server/native/linux-mediation/octant_mediation.h"

static const char content[] = "synthetic-kernel-admission";
static volatile sig_atomic_t interrupted;
static void alarmed(int number) { interrupted = number; }
static bool transfer(int fd, void *data, size_t length, bool output)
{
  struct pollfd readiness = { .fd = fd, .events = output ? POLLOUT : POLLIN };
  if (interrupted || poll(&readiness, 1, 3000) != 1 || !(readiness.revents & readiness.events)) return false;
  return (output ? write(fd, data, length) : read(fd, data, length)) == (ssize_t)length;
}

static void workload(int enrollment, int commands, int results)
{
  int held = open("/tmp/ordinary", O_RDONLY | O_CLOEXEC);
  int alias = open("/tmp/alias", O_RDONLY | O_CLOEXEC);
  if (held < 0 || alias < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(2);
  close(enrollment);
  for (;;) {
    char command;
    if (!transfer(commands, &command, 1, false)) _exit(3);
    if (command == 'q') _exit(0);
    bool denied = command == 'D' || command == 'M' || command == 'X';
    int passed;
    errno = 0;
    if (command == 'm' || command == 'M') {
      void *mapped = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, held, 0);
      passed = denied ? mapped == MAP_FAILED && errno == EACCES :
        mapped != MAP_FAILED && !memcmp(mapped, content, sizeof(content) - 1);
      if (mapped != MAP_FAILED) munmap(mapped, 4096);
    } else {
      char bytes[64];
      ssize_t count = pread(command == 'l' ? alias : held, bytes, sizeof(bytes), 0);
      passed = command == 'S' ? count == -1 && errno == EAGAIN :
        denied ? count == -1 && errno == EACCES :
          count == (ssize_t)sizeof(content) - 1 && !memcmp(bytes, content, sizeof(content) - 1);
    }
    if (!transfer(results, &passed, sizeof(passed), true)) _exit(4);
  }
}

static int measure(void)
{
  signal(SIGALRM, alarmed); alarm(25);
  int seed = open("/tmp/ordinary", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (seed < 0 || write(seed, content, sizeof(content) - 1) != (ssize_t)sizeof(content) - 1) return 1;
  close(seed);
  if (link("/tmp/ordinary", "/tmp/alias")) return 2;
  struct stat inode;
  if (stat("/tmp/ordinary", &inode)) return 3;
  int broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  if (broker < 0) { printf("OCTANT_KERNEL_DEVICE_ERRNO %d\n", errno); return 4; }
  struct octant_mediation_status status;
  if (ioctl(broker, OCTANT_MEDIATION_STATUS, &status) || status.abi != OCTANT_MEDIATION_ABI ||
      status.production_coverage != 0) { close(broker); return 5; }
  int enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  int commands[2], answers[2];
  if (enrollment < 0 || pipe2(commands, O_CLOEXEC) || pipe2(answers, O_CLOEXEC)) { close(broker); return 6; }
  pid_t child = fork();
  if (child == 0) {
    close(broker); close(commands[1]); close(answers[0]);
    workload(enrollment, commands[0], answers[1]);
  }
  close(enrollment); close(commands[0]); close(answers[1]);
  if (child < 0) { close(broker); close(commands[1]); close(answers[0]); return 7; }
  const char operations[] = {'r', 'l', 'm', 'S', 'D', 'M', 'X', 'X'};
  bool passed = true;
  unsigned measured = 0;
  unsigned long long previous = 0;
  for (unsigned i = 0; i < sizeof(operations) && passed; i++) {
    char command = operations[i];
    passed = transfer(commands[1], &command, 1, true);
    if (passed && i < 7) {
      struct octant_mediation_request request;
      passed = transfer(broker, &request, sizeof(request), false) &&
        request.request_id > previous && request.reserved == 0 &&
        request.inode == (unsigned long long)inode.st_ino &&
        request.device_major == major(inode.st_dev) && request.device_minor == minor(inode.st_dev) &&
        request.operation == (command == 'm' || command == 'M' ? OCTANT_MEDIATION_MAP : OCTANT_MEDIATION_READ);
      if (!passed) break;
      previous = request.request_id;
      if (i == 6) { close(broker); broker = -1; }
      else {
        if (command == 'S') {
          int marker = open("/tmp/ordinary.pub", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
          if (marker < 0) { passed = false; break; }
          close(marker);
          struct octant_mediation_status changed;
          passed = !ioctl(broker, OCTANT_MEDIATION_STATUS, &changed) &&
            changed.namespace_epoch > request.namespace_epoch && changed.active_mutations == 0;
          if (!passed) break;
        }
        struct octant_mediation_answer answer = {
          .request_id = request.request_id,
          .namespace_epoch = request.namespace_epoch,
          .allow = i < 4,
        };
        passed = write(broker, &answer, sizeof(answer)) == sizeof(answer);
      }
    }
    int answer = 0;
    passed = passed && transfer(answers[0], &answer, sizeof(answer), false) && answer == 1;
    measured++;
  }
  char quit = 'q';
  if (!passed || !transfer(commands[1], &quit, 1, true)) kill(child, SIGKILL);
  int exit = 0;
  pid_t joined;
  do { joined = waitpid(child, &exit, 0); } while (joined < 0 && errno == EINTR);
  bool reaped = joined == child;
  passed = passed && reaped && WIFEXITED(exit) && WEXITSTATUS(exit) == 0;
  close(commands[1]); close(answers[0]); if (broker >= 0) close(broker);
  bool cleaned = !unlink("/tmp/ordinary.pub") && !unlink("/tmp/alias") && !unlink("/tmp/ordinary");
  printf("OCTANT_KERNEL_EVIDENCE {\"status\":\"%s\",\"productionReady\":false,\"measurements\":%u,\"pendingAndNewReadDeniedOnBrokerClose\":%s,\"ownedChildJoined\":%s,\"cleaned\":%s}\n",
    passed && cleaned ? "measured-admission-core" : "failed", measured,
    passed ? "true" : "false", reaped ? "true" : "false", cleaned ? "true" : "false");
  return passed && cleaned ? 0 : 8;
}

int main(void)
{
  mkdir("/dev", 0755); mkdir("/proc", 0755); mkdir("/tmp", 0700);
  if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) || mount("proc", "/proc", "proc", 0, NULL) ||
      mount("tmpfs", "/tmp", "tmpfs", 0, "size=1m")) {
    puts("OCTANT_KERNEL_FAILURE guest mounts unavailable");
  } else {
    int result = measure();
    printf("OCTANT_KERNEL_EXIT %d\n", result);
  }
  fflush(stdout);
  reboot(RB_POWER_OFF);
  return 1;
}
