/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#include <linux/mount.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../../apps/server/native/linux-mediation/octant_mediation.h"

static const char content[] = "synthetic-kernel-admission";
static volatile sig_atomic_t interrupted;
struct thread_read { int file, passed; };
static void *read_on_thread(void *argument)
{
  struct thread_read *input = argument;
  char bytes[64];
  ssize_t count = pread(input->file, bytes, sizeof(bytes), 0);
  input->passed = count == (ssize_t)sizeof(content) - 1 && !memcmp(bytes, content, sizeof(content) - 1);
  return NULL;
}
static void alarmed(int number) { interrupted = number; }
static bool transfer(int fd, void *data, size_t length, bool output)
{
  struct pollfd readiness = { .fd = fd, .events = output ? POLLOUT : POLLIN };
  if (interrupted || poll(&readiness, 1, 3000) != 1 || !(readiness.revents & readiness.events)) return false;
  return (output ? write(fd, data, length) : read(fd, data, length)) == (ssize_t)length;
}

static bool send_descriptor(int socket, int file)
{
  char byte = 'F';
  struct iovec data = {.iov_base = &byte, .iov_len = 1};
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = {.msg_iov = &data, .msg_iovlen = 1,
    .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &file, sizeof(file));
  return sendmsg(socket, &message, MSG_NOSIGNAL) == 1;
}
static int receive_descriptor(int socket, bool *truncated)
{
  char byte = 0;
  struct iovec data = {.iov_base = &byte, .iov_len = 1};
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = {.msg_iov = &data, .msg_iovlen = 1,
    .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  if (recvmsg(socket, &message, MSG_CMSG_CLOEXEC) != 1 || byte != 'F') return -2;
  *truncated = (message.msg_flags & MSG_CTRUNC) != 0;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  int file = -1;
  if (header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS &&
      header->cmsg_len == CMSG_LEN(sizeof(int))) memcpy(&file, CMSG_DATA(header), sizeof(file));
  return file;
}
static bool same_policy_transfer(int inherited)
{
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, sockets)) return false;
  pid_t peer = fork();
  if (!peer) { close(sockets[0]); _exit(send_descriptor(sockets[1], inherited) ? 0 : 1); }
  close(sockets[1]);
  if (peer < 0) { close(sockets[0]); return false; }
  // Reap the sender first: the queued record must retain the actual sending
  // credentials after that process has exited, without looking up its PID.
  int result = 0; pid_t joined;
  do { joined = waitpid(peer, &result, 0); } while (joined < 0 && errno == EINTR);
  bool truncated = false;
  int received = receive_descriptor(sockets[0], &truncated);
  char bytes[64];
  bool passed = received >= 0 && !truncated && pread(received, bytes, sizeof(bytes), 0) == sizeof(content) - 1;
  if (received >= 0) close(received);
  close(sockets[0]);
  return passed && joined == peer && WIFEXITED(result) && WEXITSTATUS(result) == 0;
}
static bool same_policy_shared_memory(void)
{
  int *page = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (page == MAP_FAILED) return false;
  *page = 42;
  pid_t peer = fork();
  if (!peer) { *page = 43; _exit(0); }
  int result = 0; pid_t joined = -1;
  if (peer > 0) do { joined = waitpid(peer, &result, 0); } while (joined < 0 && errno == EINTR);
  bool passed = peer > 0 && joined == peer && WIFEXITED(result) && WEXITSTATUS(result) == 0 && *page == 43;
  munmap(page, 4096);
  return passed;
}

static void workload(int enrollment, int commands, int results, int foreign)
{
  int held = open("/tmp/ordinary", O_RDONLY | O_CLOEXEC);
  int alias = open("/tmp/alias", O_RDONLY | O_CLOEXEC);
  int output = open("/tmp/ordinary", O_WRONLY | O_CLOEXEC);
  if (held < 0 || alias < 0 || output < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(2);
  close(enrollment);
  for (;;) {
    char command;
    if (!transfer(commands, &command, 1, false)) _exit(3);
    if (command == 'q') _exit(0);
    bool denied = command == 'D' || command == 'M' || command == 'X';
    int passed;
    errno = 0;
    if (command == 'c') {
      passed = same_policy_transfer(held);
    } else if (command == 'g') {
      passed = same_policy_shared_memory();
    } else if (command == 'n' || command == 'p') {
      bool truncated = false;
      int received = receive_descriptor(foreign, &truncated);
      passed = received == -1 && truncated;
      if (received >= 0) close(received);
    } else if (command == 'F') {
      passed = ftruncate(output, 0) == -1 && errno == EACCES;
    } else if (command == 'P') {
      passed = truncate("/tmp/ordinary", 0) == -1 && errno == EACCES;
    } else if (command == 'O') {
      int opened = open("/tmp/ordinary", O_TRUNC | O_WRONLY | O_CLOEXEC);
      passed = opened == -1 && errno == EACCES;
      if (opened >= 0) close(opened);
    } else if (command == 'a') {
      unsigned long context = 0;
      long ring = syscall(SYS_io_uring_setup, 1, NULL);
      int ring_error = errno;
      long aio = syscall(SYS_io_setup, 1, &context);
      passed = ring == -1 && ring_error == ENOSYS && aio == -1 && errno == ENOSYS;
    } else if (command == 't') {
      struct thread_read input = {.file = held};
      pthread_t thread;
      passed = pthread_create(&thread, NULL, read_on_thread, &input) == 0;
      if (passed) passed = pthread_join(thread, NULL) == 0 && input.passed;
    } else if (command == 'w') {
      passed = pwrite(output, content, sizeof(content) - 1, 0) == (ssize_t)sizeof(content) - 1;
    } else if (command == 'm' || command == 'M') {
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

static bool refuses_inherited_proc(int broker)
{
  int enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  if (enrollment < 0) return false;
  pid_t child = fork();
  if (!child) {
    close(broker);
    int memory = open("/proc/self/mem", O_RDONLY | O_CLOEXEC);
    if (memory < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) _exit(1);
    errno = 0;
    if (ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0) != -1 || errno != EPERM) _exit(2);
    close(memory);
    /* Refusal must not consume enrollment or change the starting principal. */
    _exit(ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0) ? 3 : 0);
  }
  close(enrollment);
  if (child < 0) return false;
  int result; pid_t joined;
  do { joined = waitpid(child, &result, 0); } while (joined < 0 && errno == EINTR);
  return joined == child && WIFEXITED(result) && WEXITSTATUS(result) == 0;
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
  if (!refuses_inherited_proc(broker)) { close(broker); return 9; }
  int enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  int commands[2], answers[2], foreign[2];
  if (enrollment < 0 || pipe2(commands, O_CLOEXEC) || pipe2(answers, O_CLOEXEC) ||
      socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, foreign)) { close(broker); return 6; }
  // Queue an actual foreign record before the receiver enrolls. The later
  // receiver context cannot retroactively turn that sender into its peer.
  int queued = open("/tmp/ordinary", O_RDONLY | O_CLOEXEC);
  if (queued < 0 || !send_descriptor(foreign[0], queued)) return 10;
  close(queued);
  pid_t child = fork();
  if (child == 0) {
    struct octant_mediation_status forwarded;
    struct octant_mediation_request request;
    struct octant_mediation_answer answer = {0};
    errno = 0;
    if (ioctl(broker, OCTANT_MEDIATION_STATUS, &forwarded) != -1 || errno != EPERM) _exit(40);
    errno = 0;
    if (read(broker, &request, sizeof(request)) != -1 || errno != EPERM) _exit(41);
    errno = 0;
    if (write(broker, &answer, sizeof(answer)) != -1 || errno != EPERM) _exit(42);
    errno = 0;
    if (ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0) != -1 || errno != EPERM) _exit(43);
    struct octant_mediation_parent parent = {0};
    errno = 0;
    if (ioctl(broker, OCTANT_MEDIATION_PARENT_FD, &parent) != -1 || errno != EPERM) _exit(44);
    close(broker); close(commands[1]); close(answers[0]); close(foreign[0]);
    workload(enrollment, commands[0], answers[1], foreign[1]);
  }
  close(enrollment); close(commands[0]); close(answers[1]); close(foreign[1]);
  if (child < 0) { close(broker); close(commands[1]); close(answers[0]); return 7; }
  const char operations[] = {'r', 'l', 'm', 't', 'c', 'g', 'n', 'p', 'w', 'a', 'S', 'D', 'M', 'F', 'P', 'O', 'X', 'X'};
  bool passed = true;
  unsigned measured = 0;
  unsigned long long previous = 0;
  for (unsigned i = 0; i < sizeof(operations) && passed; i++) {
    char command = operations[i];
    if (command == 'p') {
      int file = open("/proc/self/mem", O_RDONLY | O_CLOEXEC);
      passed = file >= 0 && send_descriptor(foreign[0], file);
      if (file >= 0) close(file);
    }
    passed = passed && transfer(commands[1], &command, 1, true);
    if (passed && command != 'a' && command != 'g' && command != 'n' && command != 'p' && broker >= 0) {
      struct octant_mediation_request request;
      passed = transfer(broker, &request, sizeof(request), false) &&
        request.request_id > previous && request.reserved == 0 &&
        request.inode == (unsigned long long)inode.st_ino &&
        request.device_major == major(inode.st_dev) && request.device_minor == minor(inode.st_dev) &&
        request.operation == (command == 'm' || command == 'M' ? OCTANT_MEDIATION_MAP :
          command == 'w' || command == 'F' || command == 'P' || command == 'O' ?
            OCTANT_MEDIATION_WRITE : OCTANT_MEDIATION_READ);
      if (!passed) break;
      printf("OCTANT_KERNEL_STEP %u operation=%u epoch=%llu\n", i,
        request.operation, (unsigned long long)request.namespace_epoch);
      previous = request.request_id;
      if (command == 'X') { close(broker); broker = -1; }
      else {
        if (command == 'S') {
          int marker = open("/tmp/ordinary.pub", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
          if (marker < 0) { passed = false; break; }
          close(marker);
          struct octant_mediation_status changed = {0};
          passed = !ioctl(broker, OCTANT_MEDIATION_STATUS, &changed) &&
            changed.namespace_epoch > request.namespace_epoch && changed.active_mutations == 0;
          printf("OCTANT_KERNEL_MUTATION before=%llu after=%llu active=%u\n",
            (unsigned long long)request.namespace_epoch,
            (unsigned long long)changed.namespace_epoch, changed.active_mutations);
          if (!passed) break;
        }
        struct octant_mediation_answer answer = {
          .request_id = request.request_id,
          .namespace_epoch = request.namespace_epoch,
          .allow = command == 'r' || command == 'l' || command == 'm' || command == 't' || command == 'c' || command == 'w' || command == 'S',
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
  close(commands[1]); close(answers[0]); close(foreign[0]); if (broker >= 0) close(broker);
  bool cleaned = !unlink("/tmp/ordinary.pub") && !unlink("/tmp/alias") && !unlink("/tmp/ordinary");
  printf("OCTANT_KERNEL_EVIDENCE {\"status\":\"%s\",\"productionReady\":false,\"measurements\":%u,\"inheritedProcRefused\":true,\"pendingAndNewReadDeniedOnBrokerClose\":%s,\"ownedChildJoined\":%s,\"cleaned\":%s}\n",
    passed && cleaned ? "measured-admission-core" : "failed", measured,
    passed ? "true" : "false", reaped ? "true" : "false", cleaned ? "true" : "false");
  return passed && cleaned ? 0 : 8;
}

static bool named(const struct octant_mediation_name *name, const struct stat *parent, const char *leaf)
{
  return name->parent_inode == (unsigned long long)parent->st_ino &&
    name->device_major == major(parent->st_dev) && name->device_minor == minor(parent->st_dev) &&
    name->length == strlen(leaf) && !name->reserved && !memcmp(name->bytes, leaf, name->length);
}

/* Synthetic decisions below test the real pre-lock transport and final token,
 * not the still-unintegrated structured-policy broker. */
static int namespace_measure(void)
{
  const char *files[] = {"key", "key.pub", "folder.pub", "public.pub", "stale.pub", "live"};
  if (mkdir("/tmp/ns", 0700) || mkdir("/tmp/ns/folder", 0700) ||
      mkdir("/tmp/ns/unrelated", 0700) || mkdir("/tmp/ns/empty", 0700)) return 21;
  for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); i++) {
    char path[80]; snprintf(path, sizeof(path), "/tmp/ns/%s", files[i]);
    int file = open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (file < 0 || write(file, content, sizeof(content) - 1) != sizeof(content) - 1) return 22;
    close(file);
  }
  if (link("/tmp/ns/public.pub", "/tmp/ns/alias.pub")) return 23;
  struct stat parent;
  if (stat("/tmp/ns", &parent)) return 24;
  int broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  int enrollment = broker < 0 ? -1 : ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  int results[2];
  if (enrollment < 0 || pipe2(results, O_CLOEXEC)) return 25;
  pid_t child = fork();
  if (!child) {
    close(broker); close(results[0]);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(26);
    close(enrollment);
    for (unsigned i = 0; i < 9; i++) {
      int result;
      errno = 0;
      switch (i) {
      case 0: result = unlink("/tmp/ns/key.pub"); break;
      case 1: result = rename("/tmp/ns/key.pub", "/tmp/ns/moved.pub"); break;
      case 2: result = rename("/tmp/ns/folder", "/tmp/ns/moved-folder"); break;
      case 3: result = unlink("/tmp/ns/alias.pub"); break;
      case 4: result = rename("/tmp/ns/unrelated", "/tmp/ns/moved-unrelated"); break;
      case 5: result = rmdir("/tmp/ns/empty"); break;
      case 6: result = unlink("/tmp/ns/stale.pub"); break;
      case 7: result = unlink("/tmp/ns/key.pub"); break;
      default: result = rename("/tmp/ns/folder", "/tmp/ns/moved-folder"); break;
      }
      int passed = i >= 3 && i <= 5 ? result == 0 :
        result == -1 && errno == (i == 6 ? EAGAIN : EACCES);
      if (!transfer(results[1], &passed, sizeof(passed), true) || !passed) _exit(27);
    }
    _exit(0);
  }
  close(enrollment); close(results[1]);
  if (child < 0) { close(results[0]); close(broker); return 28; }
  const char *source[] = {"key.pub", "key.pub", "folder", "alias.pub", "unrelated", "empty", "stale.pub", "key.pub"};
  const char *destination[] = {NULL, "moved.pub", "moved-folder", NULL, "moved-unrelated", NULL, NULL, NULL};
  bool passed = true;
  unsigned measured = 0;
  for (unsigned i = 0; i < 9 && passed; i++) {
    if (i < 8) {
      struct octant_mediation_request request;
      passed = transfer(broker, &request, sizeof(request), false) && !request.flags && !request.padding &&
        named(&request.source, &parent, source[i]) && request.operation ==
        (destination[i] ? OCTANT_MEDIATION_RENAME : i == 5 ? OCTANT_MEDIATION_RMDIR : OCTANT_MEDIATION_UNLINK);
      if (passed && destination[i]) passed = named(&request.destination, &parent, destination[i]);
      if (passed && i == 6) {
        /* Same-parent external rename must finish while the broker waits:
         * there is no parent inode lock held across this policy decision. */
        passed = rename("/tmp/ns/live", "/tmp/ns/live-moved") == 0;
      }
      if (passed && i == 7) { close(broker); broker = -1; }
      else if (passed) {
        struct octant_mediation_answer answer = {.request_id = request.request_id,
          .namespace_epoch = request.namespace_epoch, .allow = i >= 3 && i <= 6};
        passed = write(broker, &answer, sizeof(answer)) == sizeof(answer);
      }
    }
    int result = 0;
    passed = passed && transfer(results[0], &result, sizeof(result), false) && result == 1;
    printf("OCTANT_KERNEL_NAMESPACE_STEP %u passed=%u\n", i, passed);
    measured++;
  }
  if (!passed) kill(child, SIGKILL);
  int exit = 0; pid_t joined;
  do { joined = waitpid(child, &exit, 0); } while (joined < 0 && errno == EINTR);
  bool reaped = joined == child;
  passed = passed && reaped && WIFEXITED(exit) && WEXITSTATUS(exit) == 0;
  close(results[0]); if (broker >= 0) close(broker);
  bool controls = access("/tmp/ns/key", F_OK) == 0 && access("/tmp/ns/key.pub", F_OK) == 0 &&
    access("/tmp/ns/folder", F_OK) == 0 && access("/tmp/ns/public.pub", F_OK) == 0 &&
    access("/tmp/ns/moved-unrelated", F_OK) == 0 && access("/tmp/ns/stale.pub", F_OK) == 0;
  for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); i++) {
    char path[80]; snprintf(path, sizeof(path), "/tmp/ns/%s", files[i]); unlink(path);
  }
  unlink("/tmp/ns/live-moved"); unlink("/tmp/ns/alias.pub");
  rmdir("/tmp/ns/folder"); rmdir("/tmp/ns/unrelated"); rmdir("/tmp/ns/moved-unrelated"); rmdir("/tmp/ns/empty");
  bool cleaned = rmdir("/tmp/ns") == 0;
  printf("OCTANT_KERNEL_NAMESPACE {\"status\":\"%s\",\"measurements\":%u,\"productionReady\":false,\"ownedChildJoined\":%s,\"cleaned\":%s}\n",
    passed && controls && cleaned ? "measured-namespace-token" : "failed", measured, reaped ? "true" : "false", cleaned ? "true" : "false");
  return passed && controls && cleaned ? 0 : 29;
}

struct ordered_read {
  int file, identity, first_done;
  bool twice;
  int passed;
};
static void *ordered_reader(void *argument)
{
  struct ordered_read *input = argument;
  if (input->twice) {
    pid_t tid = (pid_t)syscall(SYS_gettid);
    if (!transfer(input->identity, &tid, sizeof(tid), true)) return NULL;
  }
  char bytes[64];
  input->passed = pread(input->file, bytes, sizeof(bytes), 0) == sizeof(content) - 1 &&
    !memcmp(bytes, content, sizeof(content) - 1);
  if (input->twice && input->passed) {
    char done = 'D';
    if (!transfer(input->first_done, &done, 1, true)) { input->passed = 0; return NULL; }
    input->passed = pread(input->file, bytes, sizeof(bytes), 0) == sizeof(content) - 1 &&
      !memcmp(bytes, content, sizeof(content) - 1);
  }
  return NULL;
}
static bool reader_waiting(pid_t child, pid_t tid)
{
  char path[128];
  snprintf(path, sizeof(path), "/proc/%d/task/%d/stat", child, tid);
  for (unsigned attempt = 0; attempt < 500; attempt++) {
    FILE *file = fopen(path, "re");
    char bytes[512] = {0};
    if (!file) return false;
    bool read = fgets(bytes, sizeof(bytes), file) != NULL;
    fclose(file);
    char *end = read ? strrchr(bytes, ')') : NULL;
    if (end && end[1] == ' ' && end[2] == 'S') return true;
    struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  }
  return false;
}

static int ordered_measure(void)
{
  int file = open("/tmp/ordered", O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
  if (file < 0 || write(file, content, sizeof(content) - 1) != sizeof(content) - 1) return 50;
  struct stat expected;
  if (fstat(file, &expected)) return 60;
  int broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  int enrollment = broker < 0 ? -1 : ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  int commands[2], identity[2], done[2], results[2];
  if (enrollment < 0 || pipe2(commands, O_CLOEXEC) || pipe2(identity, O_CLOEXEC) ||
      pipe2(done, O_CLOEXEC) || pipe2(results, O_CLOEXEC)) return 51;
  pid_t child = fork();
  if (!child) {
    close(broker); close(commands[1]); close(identity[0]); close(done[0]); close(results[0]);
    signal(SIGALRM, SIG_DFL); alarm(8);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(52);
    close(enrollment);
    struct ordered_read first = {.file = file, .identity = identity[1], .first_done = done[1], .twice = true};
    struct ordered_read second = {.file = file};
    pthread_t a, b;
    if (pthread_create(&a, NULL, ordered_reader, &first)) _exit(53);
    char command;
    if (!transfer(commands[0], &command, 1, false) || command != 'B' ||
        pthread_create(&b, NULL, ordered_reader, &second)) _exit(54);
    if (pthread_join(a, NULL) || pthread_join(b, NULL)) _exit(55);
    int passed = first.passed && second.passed;
    if (!transfer(results[1], &passed, sizeof(passed), true)) _exit(56);
    _exit(passed ? 0 : 57);
  }
  close(enrollment); close(commands[0]); close(identity[1]); close(done[1]); close(results[1]);
  if (child < 0) return 58;
  pid_t tid = 0;
  struct octant_mediation_request first = {0}, second = {0}, third = {0};
  bool passed = transfer(identity[0], &tid, sizeof(tid), false) &&
    transfer(broker, &first, sizeof(first), false);
  char start = 'B';
  passed = passed && transfer(commands[1], &start, 1, true);
  /* R1 is delivered and held. POLLIN now proves R2 is queued, without
   * consuming it; a later R3 can then reuse the completed first slot. */
  struct pollfd queued = {.fd = broker, .events = POLLIN};
  passed = passed && poll(&queued, 1, 1000) == 1 && (queued.revents & POLLIN);
  struct octant_mediation_answer answer = {.request_id = first.request_id,
    .namespace_epoch = first.namespace_epoch, .allow = 1};
  passed = passed && write(broker, &answer, sizeof(answer)) == sizeof(answer);
  char completed = 0;
  /* After A signals first-read completion, its only blocking operation is
   * the next guarded pread. Its sleeping task state proves R3 is queued. */
  passed = passed && transfer(done[0], &completed, 1, false) && completed == 'D' && reader_waiting(child, tid);
  passed = passed && transfer(broker, &second, sizeof(second), false);
  bool oldest_first = passed && first.request_id > 0 && second.request_id == first.request_id + 1;
  if (passed) {
    answer = (struct octant_mediation_answer) {.request_id = second.request_id,
      .namespace_epoch = second.namespace_epoch, .allow = 1};
    passed = write(broker, &answer, sizeof(answer)) == sizeof(answer) &&
      transfer(broker, &third, sizeof(third), false);
  }
  oldest_first = oldest_first && third.request_id == first.request_id + 2;
  const struct octant_mediation_request *requests[] = {&first, &second, &third};
  for (unsigned i = 0; i < sizeof(requests) / sizeof(requests[0]); i++) {
    const struct octant_mediation_request *request = requests[i];
    passed = passed && request->operation == OCTANT_MEDIATION_READ && !request->reserved &&
      request->inode == (unsigned long long)expected.st_ino &&
      request->device_major == major(expected.st_dev) && request->device_minor == minor(expected.st_dev);
  }
  if (passed) {
    answer = (struct octant_mediation_answer) {.request_id = third.request_id,
      .namespace_epoch = third.namespace_epoch, .allow = 1};
    passed = write(broker, &answer, sizeof(answer)) == sizeof(answer);
  }
  int reads = 0;
  passed = passed && transfer(results[0], &reads, sizeof(reads), false) && reads == 1;
  close(broker);
  if (!passed) kill(child, SIGKILL);
  int exit; pid_t joined;
  do { joined = waitpid(child, &exit, 0); } while (joined < 0 && errno == EINTR);
  bool reaped = joined == child;
  passed = passed && oldest_first && reaped && WIFEXITED(exit) && WEXITSTATUS(exit) == 0;
  close(file); close(commands[1]); close(identity[0]); close(done[0]); close(results[0]);
  bool cleaned = unlink("/tmp/ordered") == 0;
  printf("OCTANT_ORDERED_ADMISSIONS {\"status\":\"%s\",\"first\":%llu,\"second\":%llu,\"third\":%llu,\"ownedChildJoined\":%s,\"cleaned\":%s,\"productionReady\":false}\n",
    passed && cleaned ? "measured-ordered-admissions" : "failed", (unsigned long long)first.request_id,
    (unsigned long long)second.request_id, (unsigned long long)third.request_id,
    reaped ? "true" : "false", cleaned ? "true" : "false");
  return passed && cleaned ? 0 : 59;
}

static void close_owned(int *descriptor)
{
  if (*descriptor >= 0) close(*descriptor);
  *descriptor = -1;
}

static bool join_owned(pid_t child, bool *normal)
{
  if (child <= 0) return false;
  int status = 0;
  pid_t joined = 0;
  for (unsigned attempt = 0; attempt < 100; attempt++) {
    joined = waitpid(child, &status, WNOHANG);
    if (joined == child || (joined < 0 && errno != EINTR)) break;
    struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  }
  if (!joined || (joined < 0 && errno == EINTR)) {
    kill(child, SIGKILL);
    do { joined = waitpid(child, &status, 0); } while (joined < 0 && errno == EINTR);
  }
  *normal = joined == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
  return joined == child;
}

#define EPOCH_ROOT "/tmp/octant-epoch-mount"
#define EPOCH_FILE "/tmp/octant-epoch-content"
static const char *epoch_cases[] = {
  "pivot-root", "remount", "mount-setattr", "propagation", "open-create",
  "tmpfile", "empty-link", "rename", "bind-mount", "bind-remount",
};

/* An unenrolled writer owns a private mount namespace. It signals completion
 * before it exits, so namespace destruction cannot hide a missing epoch hook. */
static void outside_mutation(unsigned operation, int command, int result)
{
  alarm(8);
  int temporary = -1;
  if (unshare(CLONE_NEWNS) || mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) _exit(1);
  if (operation == 0 && (mount("/", "/", NULL, MS_BIND | MS_REC, NULL) || chdir("/") || chroot("."))) _exit(2);
  if (mount("tmpfs", EPOCH_ROOT, "tmpfs", 0, "size=64k") ||
      mkdir(EPOCH_ROOT "/old", 0700) || mkdir(EPOCH_ROOT "/mount", 0700)) _exit(3);
  if (operation == 6) {
    temporary = open(EPOCH_ROOT, O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
    if (temporary < 0) _exit(4);
  }
  if (operation == 7) {
    int file = open(EPOCH_ROOT "/move", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (file < 0) _exit(5);
    close(file);
  }
  int ready = 1;
  char next;
  if (!transfer(result, &ready, sizeof(ready), true) ||
      !transfer(command, &next, 1, false) || next != 'M') _exit(6);
  int changed = -1;
  switch (operation) {
    case 0: changed = syscall(SYS_pivot_root, EPOCH_ROOT, EPOCH_ROOT "/old"); break;
    case 1: changed = mount(NULL, EPOCH_ROOT, NULL, MS_REMOUNT | MS_RDONLY, NULL); break;
    case 2: {
      struct mount_attr attributes = {.attr_set = MOUNT_ATTR_RDONLY};
      changed = syscall(SYS_mount_setattr, AT_FDCWD, EPOCH_ROOT, 0, &attributes, sizeof(attributes));
      break;
    }
    case 3: changed = mount(NULL, EPOCH_ROOT, NULL, MS_SHARED, NULL); break;
    case 4: {
      int file = open(EPOCH_ROOT "/created", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
      changed = file < 0 ? -1 : close(file);
      break;
    }
    case 5: {
      int file = open(EPOCH_ROOT, O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
      changed = file < 0 ? -1 : close(file);
      break;
    }
    case 6: changed = linkat(temporary, "", AT_FDCWD, EPOCH_ROOT "/linked", AT_EMPTY_PATH); break;
    case 7: changed = rename(EPOCH_ROOT "/move", EPOCH_ROOT "/moved"); break;
    case 8: changed = mount(EPOCH_ROOT "/old", EPOCH_ROOT "/mount", NULL, MS_BIND, NULL); break;
    case 9: changed = mount(NULL, EPOCH_ROOT, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL); break;
  }
  int outcome = changed ? errno : 0;
  if (!transfer(result, &outcome, sizeof(outcome), true) || !transfer(command, &next, 1, false) || next != 'q') _exit(7);
  if (temporary >= 0) close(temporary);
  _exit(0);
}

static bool outside_epoch_case(unsigned operation)
{
  int actor_commands[2] = {-1, -1}, actor_results[2] = {-1, -1};
  int commands[2] = {-1, -1}, results[2] = {-1, -1};
  int broker = -1, enrollment = -1;
  pid_t actor = -1, reader = -1;
  bool ready = false, changed = false, advanced = false, stale = false, fresh = false;
  bool file_created = false, directory_created = false;
  bool actor_joined = false, reader_joined = false, actor_normal = false, reader_normal = false;
  int seed = open(EPOCH_FILE, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  file_created = seed >= 0;
  bool seeded = seed >= 0 && write(seed, content, sizeof(content) - 1) == sizeof(content) - 1;
  close_owned(&seed);
  if (!seeded || mkdir(EPOCH_ROOT, 0700)) goto cleanup;
  directory_created = true;
  if (pipe2(actor_commands, O_CLOEXEC) ||
      pipe2(actor_results, O_CLOEXEC) || pipe2(commands, O_CLOEXEC) || pipe2(results, O_CLOEXEC)) goto cleanup;
  actor = fork();
  if (!actor) {
    close(actor_commands[1]); close(actor_results[0]);
    close(commands[0]); close(commands[1]); close(results[0]); close(results[1]);
    outside_mutation(operation, actor_commands[0], actor_results[1]);
  }
  if (actor < 0) goto cleanup;
  close_owned(&actor_commands[0]); close_owned(&actor_results[1]);
  int message = 0;
  ready = transfer(actor_results[0], &message, sizeof(message), false) && message == 1;
  if (!ready) goto cleanup;
  broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC);
  if (broker < 0) goto cleanup;
  enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  if (enrollment < 0) goto cleanup;
  reader = fork();
  if (!reader) {
    close(broker); close(actor_commands[1]); close(actor_results[0]);
    close(commands[1]); close(results[0]);
    int file = open(EPOCH_FILE, O_RDONLY | O_CLOEXEC);
    if (file < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(1);
    close(enrollment);
    for (;;) {
      char command;
      if (!transfer(commands[0], &command, 1, false)) _exit(2);
      if (command == 'q') _exit(0);
      char bytes[64]; errno = 0;
      ssize_t count = pread(file, bytes, sizeof(bytes), 0);
      int valid = command == 'S' ? count == -1 && errno == EAGAIN :
        count == sizeof(content) - 1 && !memcmp(bytes, content, sizeof(content) - 1);
      if (!transfer(results[1], &valid, sizeof(valid), true)) _exit(3);
    }
  }
  close_owned(&enrollment); close_owned(&commands[0]); close_owned(&results[1]);
  if (reader < 0) goto cleanup;
  struct stat identity;
  if (stat(EPOCH_FILE, &identity)) goto cleanup;
  char command = 'S';
  struct octant_mediation_request request;
  if (!transfer(commands[1], &command, 1, true) || !transfer(broker, &request, sizeof(request), false) ||
      request.operation != OCTANT_MEDIATION_READ || request.inode != (unsigned long long)identity.st_ino ||
      request.device_major != major(identity.st_dev) || request.device_minor != minor(identity.st_dev)) goto cleanup;
  command = 'M'; message = -1;
  changed = transfer(actor_commands[1], &command, 1, true) &&
    transfer(actor_results[0], &message, sizeof(message), false) && message == 0;
  if (!changed) goto cleanup;
  struct octant_mediation_status after;
  if (ioctl(broker, OCTANT_MEDIATION_STATUS, &after)) goto cleanup;
  advanced = after.active_mutations == 0 && after.namespace_epoch > request.namespace_epoch;
  struct octant_mediation_answer answer = {.request_id = request.request_id,
    .namespace_epoch = request.namespace_epoch, .allow = 1};
  if (write(broker, &answer, sizeof(answer)) != sizeof(answer)) goto cleanup;
  message = 0;
  stale = transfer(results[0], &message, sizeof(message), false) && message == 1;
  unsigned long long previous = request.request_id;
  command = 'A';
  if (!transfer(commands[1], &command, 1, true) || !transfer(broker, &request, sizeof(request), false) ||
      request.request_id <= previous || request.operation != OCTANT_MEDIATION_READ ||
      request.inode != (unsigned long long)identity.st_ino || request.namespace_epoch != after.namespace_epoch) goto cleanup;
  answer = (struct octant_mediation_answer) {.request_id = request.request_id,
    .namespace_epoch = request.namespace_epoch, .allow = 1};
  if (write(broker, &answer, sizeof(answer)) != sizeof(answer)) goto cleanup;
  message = 0;
  fresh = transfer(results[0], &message, sizeof(message), false) && message == 1;
cleanup:
  if (reader > 0 && fresh) { char quit = 'q'; transfer(commands[1], &quit, 1, true); }
  if (actor > 0 && ready && changed) { char quit = 'q'; transfer(actor_commands[1], &quit, 1, true); }
  close_owned(&broker); close_owned(&enrollment);
  close_owned(&actor_commands[0]); close_owned(&actor_commands[1]);
  close_owned(&actor_results[0]); close_owned(&actor_results[1]);
  close_owned(&commands[0]); close_owned(&commands[1]); close_owned(&results[0]); close_owned(&results[1]);
  if (reader > 0) reader_joined = join_owned(reader, &reader_normal);
  if (actor > 0) actor_joined = join_owned(actor, &actor_normal);
  bool file_removed = file_created && !unlink(EPOCH_FILE);
  bool directory_removed = directory_created && !rmdir(EPOCH_ROOT);
  bool cleaned = file_removed && directory_removed;
  bool passed = changed && advanced && stale && fresh && actor_joined && reader_joined && actor_normal && reader_normal && cleaned;
  printf("OCTANT_OUTSIDE_EPOCH {\"case\":\"%s\",\"mutationSucceeded\":%s,\"epochAdvanced\":%s,\"staleRefused\":%s,\"freshAllowed\":%s,\"childrenJoined\":%s,\"cleaned\":%s,\"passed\":%s,\"productionReady\":false}\n",
    epoch_cases[operation], changed ? "true" : "false", advanced ? "true" : "false", stale ? "true" : "false",
    fresh ? "true" : "false", actor_joined && reader_joined ? "true" : "false", cleaned ? "true" : "false", passed ? "true" : "false");
  return passed;
}

static int outside_epoch_measure(void)
{
  alarm(30);
  bool passed = true;
  for (unsigned operation = 0; operation < sizeof(epoch_cases) / sizeof(epoch_cases[0]); operation++)
    if (!outside_epoch_case(operation)) passed = false;
  return passed ? 0 : 60;
}

static int policy_measure(const char *mode)
{
  pid_t child = fork();
  if (!child) {
    char *arguments[] = {"/policy-broker", (char *)mode, NULL};
    char *environment[] = {"HOME=/tmp", "PATH=/", "LANG=C", "BUN_JSC_useFTLJIT=0", NULL};
    if (mode && !strcmp(mode, "--metadata-control")) environment[3] = NULL;
    execve(arguments[0], arguments, environment);
    _exit(31);
  }
  if (child < 0) {
    printf("OCTANT_POLICY_PROCESS {\"mode\":\"%s\",\"forked\":false,\"errno\":%d}\n", mode ? mode : "direct", errno);
    return 32;
  }
  int result = 0; pid_t joined;
  do { joined = waitpid(child, &result, 0); } while (joined < 0 && errno == EINTR);
  printf("OCTANT_POLICY_PROCESS {\"mode\":\"%s\",\"forked\":true,\"joined\":%s,\"code\":%d,\"signal\":%d,\"waitErrno\":%d}\n",
    mode ? mode : "direct", joined == child ? "true" : "false",
    joined == child && WIFEXITED(result) ? WEXITSTATUS(result) : -1,
    joined == child && WIFSIGNALED(result) ? WTERMSIG(result) : 0,
    joined < 0 ? errno : 0);
  return joined == child && WIFEXITED(result) && WEXITSTATUS(result) == 0 ? 0 : 33;
}

int main(void)
{
  signal(SIGPIPE, SIG_IGN);
  mkdir("/dev", 0755); mkdir("/proc", 0755); mkdir("/tmp", 0700);
  struct statfs device_filesystem;
  struct stat console, null;
  if (statfs("/dev", &device_filesystem) || device_filesystem.f_type != TMPFS_MAGIC ||
      stat("/dev/console", &console) || !S_ISCHR(console.st_mode) ||
      major(console.st_rdev) != 5 || minor(console.st_rdev) != 1 ||
      stat("/dev/null", &null) || !S_ISCHR(null.st_mode) ||
      major(null.st_rdev) != 1 || minor(null.st_rdev) != 3) {
    printf("OCTANT_KERNEL_FAILURE automatic devtmpfs validation errno=%d\n", errno);
  } else if (mount("proc", "/proc", "proc", 0, NULL)) {
    printf("OCTANT_KERNEL_FAILURE guest proc mount errno=%d\n", errno);
  } else if (mount("tmpfs", "/tmp", "tmpfs", 0, "size=1m")) {
    printf("OCTANT_KERNEL_FAILURE private guest tmpfs mount errno=%d\n", errno);
  } else {
    long cpus = sysconf(_SC_NPROCESSORS_ONLN);
    printf("OCTANT_KERNEL_CPUS %ld\n", cpus);
    int result = cpus == 2 ? policy_measure("--metadata-control") : 61;
    if (!result) result = measure();
    if (!result) result = namespace_measure();
    if (!result) result = ordered_measure();
    if (!result) result = outside_epoch_measure();
    if (!result) {
      alarm(0);
      result = policy_measure(NULL);
    }
    // Reuse the same scenario, not a broader matrix: the earlier UID-map
    // failure was timing-sensitive. Ordinary policy processes have a 15s
    // bound and the two runtime processes 25s each;
    // the independent QEMU supervisor owns a 150s maximum for the whole guest.
    for (unsigned attempt = 0; attempt < 3 && !result; attempt++) {
      result = policy_measure("--bubblewrap");
      printf("OCTANT_BUBBLEWRAP_ATTEMPT %u result=%d\n", attempt + 1, result);
    }
    if (!result) result = policy_measure("--runtime-bun");
    if (!result) result = policy_measure("--runtime-node");
    printf("OCTANT_KERNEL_EXIT %d\n", result);
  }
  fflush(stdout);
  reboot(RB_POWER_OFF);
  return 1;
}
