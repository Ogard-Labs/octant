/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "octant_mediation.h"

/* The trusted host creates FD 3 as a private duplex channel. It is never the
 * command's stdin/stdout/stderr and never crosses enrollment into the capsule. */
_Static_assert(sizeof(struct octant_mediation_request) == 608, "request ABI layout differs");
_Static_assert(offsetof(struct octant_mediation_request, operation) == 32, "operation ABI layout differs");
_Static_assert(offsetof(struct octant_mediation_request, source) == 48, "name ABI layout differs");
_Static_assert(sizeof(struct octant_mediation_status) == 24, "status ABI layout differs");
_Static_assert(sizeof(struct octant_mediation_answer) == 24, "answer ABI layout differs");
#define CONTROL 3
#define MAXIMUM_SECONDS 180
static volatile sig_atomic_t stopped;
static void stop(int signal) { stopped = signal; }
static int64_t milliseconds(void)
{
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time)) return -1;
  return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

static bool transfer(void *bytes, size_t length, bool output)
{
  int64_t deadline = milliseconds() + 1000;
  size_t offset = 0;
  while (offset < length && !stopped) {
    int64_t remaining = deadline - milliseconds();
    struct pollfd ready = {.fd = CONTROL, .events = output ? POLLOUT : POLLIN};
    if (remaining <= 0 || poll(&ready, 1, (int)remaining) != 1 ||
        !(ready.revents & ready.events)) return false;
    ssize_t count = output ? write(CONTROL, (char *)bytes + offset, length - offset) :
      read(CONTROL, (char *)bytes + offset, length - offset);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) return false;
    offset += count;
  }
  return offset == length;
}

static bool send(char tag, void *bytes, size_t length)
{
  return transfer(&tag, 1, true) && transfer(bytes, length, true);
}

static void end_child(pid_t child, bool *joined, int *status)
{
  /* Only the process group created for this one enrolled command is touched. */
  kill(-child, SIGTERM);
  int64_t deadline = milliseconds() + 300;
  while (milliseconds() < deadline) {
    siginfo_t information = {0};
    int result = waitid(P_PID, (id_t)child, &information, WEXITED | WNOHANG | WNOWAIT);
    if (!result && information.si_pid == child) break;
    if (result < 0 && errno != EINTR) break;
    struct timespec pause = {.tv_nsec = 10000000}; nanosleep(&pause, NULL);
  }
  /* A direct child may have exited while its own descendants still remain. */
  kill(-child, SIGKILL);
  if (!*joined) {
    pid_t result;
    do { result = waitpid(child, status, 0); } while (result < 0 && errno == EINTR);
    *joined = result == child;
  }
}

int main(int argc, char **argv)
{
  if (argc < 2 || argv[1][0] != '/' || fcntl(CONTROL, F_GETFD) < 0) return 64;
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGALRM, stop); signal(SIGPIPE, SIG_IGN);
  alarm(MAXIMUM_SECONDS);
  int flags = fcntl(CONTROL, F_GETFL);
  if (flags < 0 || fcntl(CONTROL, F_SETFL, flags | O_NONBLOCK)) return 65;
  int broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  struct octant_mediation_status status;
  if (broker < 0 || ioctl(broker, OCTANT_MEDIATION_STATUS, &status) ||
      status.abi != OCTANT_MEDIATION_ABI || status.production_coverage != 0) return 66;
  int enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  if (enrollment < 0) { close(broker); return 67; }
  pid_t owner = getpid();
  pid_t child = fork();
  if (!child) {
    /* A lost trusted owner cannot leave this direct capsule launcher alive. */
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != owner || setpgid(0, 0) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0) ||
        syscall(SYS_close_range, 3u, UINT_MAX, 0u)) _exit(68);
    execv(argv[1], &argv[1]);
    _exit(69);
  }
  close(enrollment);
  if (child < 0) { close(broker); return 70; }
  /* Close the fork/setpgid scheduling race; EACCES means exec already won. */
  if (setpgid(child, child) && errno != EACCES && errno != ESRCH) stopped = SIGTERM;
  bool joined = false, pending = false, healthy = true;
  int child_status = 0;
  while (!stopped && healthy) {
    siginfo_t information = {0};
    int ended = waitid(P_PID, (id_t)child, &information, WEXITED | WNOHANG | WNOWAIT);
    if (!ended && information.si_pid == child) break;
    if (ended < 0 && errno != EINTR) { healthy = false; break; }
    struct pollfd ready[2] = {
      {.fd = CONTROL, .events = POLLIN},
      {.fd = broker, .events = pending ? 0 : POLLIN},
    };
    int count = poll(ready, 2, 20);
    if (count < 0) { if (errno == EINTR) continue; healthy = false; break; }
    if (ready[0].revents & (POLLHUP | POLLERR | POLLNVAL)) { healthy = false; break; }
    if (ready[0].revents & POLLIN) {
      char tag;
      healthy = transfer(&tag, 1, false);
      if (!healthy) break;
      if (tag == 'S') {
        healthy = !ioctl(broker, OCTANT_MEDIATION_STATUS, &status) && send('S', &status, sizeof(status));
      } else if (tag == 'A' && pending) {
        struct octant_mediation_answer answer;
        healthy = transfer(&answer, sizeof(answer), false);
        if (healthy) {
          ssize_t length = write(broker, &answer, sizeof(answer));
          /* A request can expire during metadata inspection. It is never
           * replayed, re-issued or converted to permission by this relay. */
          healthy = length == sizeof(answer) || (length < 0 && errno == ENOENT);
          pending = false;
        }
      } else healthy = false;
    }
    if (healthy && !pending && (ready[1].revents & POLLIN)) {
      struct octant_mediation_request request;
      ssize_t length = read(broker, &request, sizeof(request));
      healthy = length == sizeof(request) && send('R', &request, sizeof(request));
      pending = healthy;
    }
  }
  /* Closing the context refuses admissions before any bounded child cleanup. */
  close(broker);
  end_child(child, &joined, &child_status);
  if (healthy && !stopped && joined) {
    uint32_t exit = WIFEXITED(child_status) ? (uint32_t)WEXITSTATUS(child_status) : 128u;
    healthy = send('X', &exit, sizeof(exit));
  }
  close(CONTROL);
  return healthy && !stopped && joined ? 0 : 71;
}
